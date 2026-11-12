// Giveaways: `/giveaway start` posts an embed with an "Enter" button; a
// background loop draws winners at the end time. `/giveaway reroll` and `end`,
// plus the dashboard, call endGiveaway() directly.
//
// config shape: { ping: 'none' | 'here' | 'everyone', dmWinners: boolean }
//
// With the Economy module on, a giveaway can also charge an ENTRY FEE (taken when a member enters,
// given back when they leave before the draw or when the giveaway is cancelled) and pay a CURRENCY
// PRIZE to every winner at the draw. Both go through the money API (modules/lib/economy.js): the fee
// and the entry row, and the refund and the removal of the row, are each one transaction, so a member
// is charged exactly once and never has an entry they did not pay for. Those transactions lock the
// giveaway row first (the same row the draw and a cancel update to end it), so an entry or a leave
// either lands before the draw (and is drawn or refunded) or is refused after it: an entrant who was
// charged is in the draw or refunded, and a winner is never refunded.
//
// A cancel refunds every entry once (a per-entry `refunded` marker) and can be run again, by staff or
// by the sweep at the bottom, until nothing is left. A currency prize is paid at most once per giveaway
// and member (the `giveaway_prizes` row is written in the payout's own transaction); a payout lost to a
// crash after the draw is completed by the same sweep. A reroll pays only newly drawn winners who have
// not been paid; nothing is taken back from earlier winners, so a staff reroll can pay extra prizes.
import { allClientsReady, clientOfGuild, guildByKey } from '../platform/platformOf.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  getGiveaway,
  dueGiveaways,
  markGiveawayEnded,
  claimGiveawayEnd,
  setGiveawayWinners,
  addGiveawayEntry,
  claimGiveawayCancel,
  markGiveawayPrizesPaid,
  giveawaysWithUnpaidPrizes,
  cancelledWithUnrefunded,
  unrefundedEntrantIds,
  removeGiveawayEntry,
  hasGiveawayEntry,
  giveawayEntryCount,
  giveawayEntrantIds,
} from '../db/giveaways.js';
import { log } from '../lib/log.js';
import { every, after } from './schedule.js';
import { RESET_TEXT, abort, isResetRunning, transact } from './lib/economy.js';
import { MAX_BALANCE, formatMoney, normaliseEconomyConfig } from './lib/economyConfig.js';

export const MIN_MS = 60_000; // 1 minute
export const MAX_MS = 60 * 86_400_000; // 60 days

/** Setting limits, served to the dashboard (modules/limits.js). `winners` also bounds a reroll. */
export const LIMITS = {
  winners: { min: 1, max: 20 },
  // with the Economy module: what entering costs, and what each winner is paid
  entryFee: { min: 1, max: 1_000_000 },
  prizeAmount: { min: 1, max: MAX_BALANCE },
};
export const MAX_WINNERS = LIMITS.winners.max;

/** Winners to draw: a whole number inside the limits, 1 for anything unreadable. */
export const clampWinners = (v) =>
  Math.max(LIMITS.winners.min, Math.min(Math.floor(Number(v)) || LIMITS.winners.min, LIMITS.winners.max));

/** An entry fee, or 0 when it is not a whole number inside the limits. */
export const clampEntryFee = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, LIMITS.entryFee.max) : 0;
};
/** A currency prize, or 0 when it is not a whole number inside the limits. */
export const clampPrizeAmount = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, LIMITS.prizeAmount.max) : 0;
};
const ACCENT = 0xf0b232;

// Coalesced "N entries" footer refreshes — at most one message edit per
// COUNT_REFRESH_MS per giveaway (see scheduleCountRefresh). Keyed by giveaway id.
const COUNT_REFRESH_MS = 5000;
const pendingCountRefresh = new Map();

export function normaliseGiveawaysConfig(raw = {}) {
  return {
    ping: ['here', 'everyone'].includes(raw.ping) ? raw.ping : 'none',
    dmWinners: Boolean(raw.dmWinners),
  };
}

/**
 * Pick up to `n` distinct entries at random (Fisher-Yates). Pure — exported for
 * tests.
 * @param {string[]} pool
 * @param {number} n
 * @returns {string[]}
 */
export function pickWinners(pool, n) {
  const a = [...new Set(pool)];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

/** Message payload for a giveaway in its current state. */
export function buildGiveawayPayload(g, { entryCount = 0 } = {}) {
  const endTs = Math.floor(g.ends_at / 1000);
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`🎉 ${g.prize}`)
    // Postgres hands BIGINT back as text, and the embed builder rejects a string timestamp.
    .setTimestamp(Number(g.created_at) || Date.now());

  if (!g.ended) {
    embed.setDescription(
      [
        `Click **🎉 Enter** below to join.`,
        '',
        `Ends: <t:${endTs}:R>  ·  <t:${endTs}:f>`,
        `Winners: **${g.winners}**`,
        g.entry_fee > 0
          ? `Entry fee: **${g.entry_fee.toLocaleString('en-US')}** (given back if you leave)`
          : null,
        g.prize_amount > 0 ? `Each winner also gets **${g.prize_amount.toLocaleString('en-US')}**` : null,
        g.required_role_id ? `Requires: <@&${g.required_role_id}>` : null,
        `Hosted by: ${g.host_id ? `<@${g.host_id}>` : 'a former member'}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
    embed.setFooter({ text: `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}` });
  } else {
    const won = g.wonIds || [];
    embed
      .setColor(0x4f545c)
      .setDescription(
        [
          g.cancelled
            ? 'This giveaway was cancelled.'
            : won.length
              ? `Winner${won.length === 1 ? '' : 's'}: ${won.map((id) => `<@${id}>`).join(', ')}`
              : 'No valid entries — no winner drawn.',
          '',
          `Ended: <t:${endTs}:R>`,
          `Hosted by: ${g.host_id ? `<@${g.host_id}>` : 'a former member'}`,
        ].join('\n')
      );
    embed.setFooter({ text: `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} · giveaway ended` });
  }

  const button = new ButtonBuilder()
    .setCustomId(`gaw:enter:${g.id}`)
    .setStyle(g.ended ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setLabel(g.ended ? 'Giveaway ended' : '🎉 Enter')
    .setDisabled(Boolean(g.ended));

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] },
  };
}

/**
 * Close a giveaway (or reroll it): draw winners from the current entrants,
 * update the message, and announce. Safe to call repeatedly.
 * @param {number} id
 * @param {{ rerollCount?: number }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, winners?: string[] }>}
 */
export async function endGiveaway(id, opts = {}) {
  const g = await getGiveaway(id);
  if (!g) return { ok: false, reason: 'not-found' };

  // Only one caller draws: the expiry tick does not wait for a draw, and the dashboard or
  // /giveaway end may run at the same moment. A reroll is meant for an ended giveaway.
  if (!opts.rerollCount && !(await claimGiveawayEnd(id))) return { ok: false, reason: 'already-ended' };

  const guild = guildByKey(g.guild_id);
  if (!guild) {
    await markGiveawayEnded(id, []);
    return { ok: false, reason: 'no-guild' };
  }
  const channel =
    guild.channels.cache.get(g.channel_id) ?? (await guild.channels.fetch(g.channel_id).catch(() => null));

  // Eligible = entrants still in the guild (and still holding the required role).
  const entrants = await giveawayEntrantIds(id);
  const exclude = new Set(opts.rerollCount ? g.wonIds : []);
  const eligible = [];
  for (const uid of entrants) {
    if (exclude.has(uid)) continue;
    const member = guild.members.cache.get(uid) ?? (await guild.members.fetch(uid).catch(() => null));
    if (!member) continue;
    if (g.required_role_id && !member.roles.cache.has(g.required_role_id)) continue;
    eligible.push(uid);
  }

  const count = opts.rerollCount ? clampWinners(opts.rerollCount) : g.winners;
  const winners = pickWinners(eligible, count);

  if (opts.rerollCount) await setGiveawayWinners(id, winners);
  else await markGiveawayEnded(id, winners);

  // The currency prize: each winner is paid through the money API, once per giveaway and member.
  const economy = normaliseEconomyConfig((await getGuildModule(g.guild_id, 'economy')).config);
  let paidNow = [];
  if (g.prize_amount > 0) {
    const result = await payPrizes(g, winners, economy);
    paidNow = result.paidNow;
    if (result.complete) await markGiveawayPrizesPaid(id);
  }

  const fresh = await getGiveaway(id);
  const entryCount = await giveawayEntryCount(id);

  const pending = pendingCountRefresh.get(id);
  if (pending) {
    pending.cancel();
    pendingCountRefresh.delete(id);
  }

  if (channel?.isTextBased?.() && g.message_id) {
    const msg = await channel.messages.fetch(g.message_id).catch(() => null);
    if (msg) await msg.edit(buildGiveawayPayload(fresh, { entryCount })).catch(() => {});
  }

  if (channel?.isTextBased?.()) {
    const cfg = normaliseGiveawaysConfig((await getGuildModule(g.guild_id, 'giveaways')).config);
    // A reroll never re-pings the whole channel — only the original draw does.
    const pinging = !opts.rerollCount && cfg.ping !== 'none';
    const lead = pinging ? (cfg.ping === 'everyone' ? '@everyone ' : '@here ') : '';
    const body = winners.length
      ? `${lead}🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(', ')} — you won **${g.prize}**${prizeText(g, economy, winners, paidNow)}!`
      : `Nobody entered **${g.prize}**, so there is no winner.`;
    await channel
      .send({
        content: body,
        // 'everyone' parse covers both @everyone and @here.
        allowedMentions: { users: winners, parse: pinging ? ['everyone'] : [] },
      })
      .catch(() => {});

    if (cfg.dmWinners && winners.length) {
      for (const w of winners) {
        const user = await clientOfGuild(guild)
          .users.fetch(w)
          .catch(() => null);
        await user?.send(`You won **${g.prize}** in ${guild.name}! 🎉`).catch(() => {});
      }
    }
  }

  return { ok: true, winners };
}

/** " and 🪙 5 each" for a currency prize that was paid to every winner now, a shorter form otherwise. */
function prizeText(g, economy, winners, paidNow) {
  if (!(g.prize_amount > 0) || paidNow.length === 0) return '';
  const money = formatMoney(g.prize_amount, economy);
  if (paidNow.length === winners.length) return ` and ${money} each`;
  return ` (${money} paid to ${paidNow.map((w) => `<@${w}>`).join(', ')})`;
}

/**
 * Pay one winner the currency prize of a giveaway: the credit and the `giveaway_prizes` row are one
 * transaction, and that row's key (giveaway, member) makes a second payout a refusal (`already_paid`)
 * that changes nothing. Safe to call again after a crash.
 */
export async function payPrize(g, userId, config) {
  return transact(
    g.guild_id,
    [userId],
    () => ({
      changes: [
        {
          userId,
          cash: g.prize_amount,
          kind: 'giveaway_prize',
          clamp: true,
          reason: `Giveaway #${g.id}`,
        },
      ],
    }),
    {
      config,
      after: function* (tx) {
        const added = yield tx.run(
          'INSERT INTO giveaway_prizes (giveaway_id, user_id, amount, paid_at) VALUES (?, ?, ?, ?) ON CONFLICT (giveaway_id, user_id) DO NOTHING',
          g.id,
          userId,
          g.prize_amount,
          Date.now()
        );
        if (added.changes !== 1) abort('already_paid');
      },
    }
  );
}

/**
 * Pay the prize to each winner who has not been paid. `complete` is true when nobody is left unpaid
 * (a payout that failed is tried again by the sweep).
 * @returns {Promise<{ paidNow: string[], complete: boolean }>}
 */
async function payPrizes(g, winners, config) {
  const paidNow = [];
  let complete = true;
  for (const w of winners) {
    try {
      const out = await payPrize(g, w, config);
      if (out.ok) paidNow.push(w);
      else if (out.reason !== 'already_paid') complete = false;
    } catch (err) {
      complete = false;
      log.error('giveaways', `could not pay the prize of #${g.id} to ${w}:`, err.message);
    }
  }
  return { paidNow, complete };
}

// --- entry button -----------------------------------------------------

/** Queue a trailing footer refresh; a burst of clicks yields one edit / 5s. */
function scheduleCountRefresh(message, id) {
  if (pendingCountRefresh.has(id)) return;
  const t = after('giveaways', COUNT_REFRESH_MS, async () => {
    pendingCountRefresh.delete(id);
    const g = await getGiveaway(id);
    if (!g || g.ended) return;
    message.edit(buildGiveawayPayload(g, { entryCount: await giveawayEntryCount(id) })).catch(() => {});
  });
  pendingCountRefresh.set(id, t);
}

async function handleEnter(interaction, id) {
  const g = await getGiveaway(id);
  if (!g || g.ended) {
    return interaction.reply({ content: 'This giveaway has ended.', flags: MessageFlags.Ephemeral });
  }
  if (!(await isModuleEnabled(interaction.guildId, 'giveaways'))) {
    return interaction.reply({
      content: 'Giveaways are disabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (g.required_role_id && !interaction.member.roles.cache.has(g.required_role_id)) {
    return interaction.reply({
      content: `You need <@&${g.required_role_id}> to enter this giveaway.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  let joined;
  if (g.entry_fee > 0) {
    // A reset of the economy holds the money calls: say so now instead of waiting past Discord's 3 seconds.
    if (isResetRunning(g.guild_id)) {
      return interaction.reply({ content: RESET_TEXT, flags: MessageFlags.Ephemeral });
    }
    // An entry fee: charged with the entry, given back with the leave, each in one transaction.
    const result = await toggleEntryWithFee(g, interaction.user.id);
    if (!result.ok) {
      return interaction.reply({
        content: feeRefusalText(result, g),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
    joined = result.joined;
  } else if (await hasGiveawayEntry(id, interaction.user.id)) {
    await removeGiveawayEntry(id, interaction.user.id);
    joined = false;
  } else {
    await addGiveawayEntry(id, interaction.user.id);
    joined = true;
  }

  // Refresh the "N entries" footer — coalesced so a click burst can't spam edits.
  scheduleCountRefresh(interaction.message, id);

  const fee = g.entry_fee > 0 ? await feeText(g) : '';
  return interaction.reply({
    content: joined
      ? `You're in! 🎉${fee ? ` ${fee} was taken.` : ''}  Click again to leave${fee ? ' and get it back' : ''}.`
      : `You've left this giveaway.${fee ? ` ${fee} was given back.` : ''}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function feeText(g) {
  const economy = normaliseEconomyConfig((await getGuildModule(g.guild_id, 'economy')).config);
  return formatMoney(g.entry_fee, economy);
}

function feeRefusalText(result, g) {
  switch (result.reason) {
    case 'economy_off':
      return 'This giveaway has an entry fee, and the Economy module is off in this server.';
    case 'insufficient':
      return `You need ${g.entry_fee.toLocaleString('en-US')} in cash to enter.`;
    case 'ended':
      return 'This giveaway has ended.';
    default:
      return 'That did not work. Try again.';
  }
}

/**
 * Enter a giveaway with an entry fee (debit the fee and add the entry, one transaction) or, if the
 * member is already in, leave it (give the fee back and remove the entry, one transaction). Nobody
 * can be charged twice or get a refund twice: the entry row decides, inside the transaction.
 * @returns {Promise<{ ok: true, joined: boolean } | { ok: false, reason: string }>}
 */
export async function toggleEntryWithFee(g, userId) {
  if (!(await isModuleEnabled(g.guild_id, 'economy'))) return { ok: false, reason: 'economy_off' };
  const config = normaliseEconomyConfig((await getGuildModule(g.guild_id, 'economy')).config);
  const reasonText = `Giveaway #${g.id}`;
  const now = Date.now();
  if (!(await hasGiveawayEntry(g.id, userId))) {
    const out = await transact(
      g.guild_id,
      [userId],
      (accounts) =>
        accounts.get(userId).cash < g.entry_fee
          ? { refuse: { reason: 'insufficient' } }
          : { changes: [{ userId, cash: -g.entry_fee, kind: 'giveaway_entry', reason: reasonText }] },
      {
        now,
        config,
        after: function* (tx) {
          // Lock the giveaway row and check it is still running, in one statement: the draw and a
          // cancel end it with an update of the same row, so they take turns with this entry.
          const lock = yield tx.run('UPDATE giveaways SET ended = ended WHERE id = ? AND ended = 0', g.id);
          if (lock.changes !== 1) abort('ended');
          const added = yield tx.run(
            'INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?) ON CONFLICT (giveaway_id, user_id) DO NOTHING',
            g.id,
            userId,
            now
          );
          if (added.changes !== 1) abort('already_in');
        },
      }
    );
    // Two clicks at once: the second finds the entry there, and is refused without being charged.
    return out.ok ? { ok: true, joined: true } : { ok: false, reason: out.reason };
  }
  const out = await transact(
    g.guild_id,
    [userId],
    () => ({
      changes: [{ userId, cash: g.entry_fee, kind: 'refund', clamp: true, record: true, reason: reasonText }],
    }),
    {
      now,
      config,
      after: function* (tx) {
        const lock = yield tx.run('UPDATE giveaways SET ended = ended WHERE id = ? AND ended = 0', g.id);
        if (lock.changes !== 1) abort('ended');
        const gone = yield tx.run(
          'DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
          g.id,
          userId
        );
        if (gone.changes !== 1) abort('not_in');
      },
    }
  );
  return out.ok ? { ok: true, joined: false } : { ok: false, reason: out.reason };
}

/**
 * Refund the entries of a cancelled giveaway that have not been refunded yet. Each is one transaction
 * that sets the entry's `refunded` marker and gives the fee back (kind `refund`), so an entry is
 * refunded once however often this runs and whoever runs it (staff again, the sweep).
 * @returns {Promise<{ refunded: number, failed: number }>}
 */
async function refundCancelledEntries(g) {
  let refunded = 0;
  let failed = 0;
  if (!(g.entry_fee > 0)) return { refunded, failed };
  const config = normaliseEconomyConfig((await getGuildModule(g.guild_id, 'economy')).config);
  for (const userId of await unrefundedEntrantIds(g.id)) {
    try {
      const out = await transact(
        g.guild_id,
        [userId],
        () => ({
          changes: [
            {
              userId,
              cash: g.entry_fee,
              kind: 'refund',
              clamp: true,
              record: true,
              reason: `Giveaway #${g.id} cancelled`,
            },
          ],
        }),
        {
          config,
          after: function* (tx) {
            const marked = yield tx.run(
              'UPDATE giveaway_entries SET refunded = 1 WHERE giveaway_id = ? AND user_id = ? AND refunded = 0',
              g.id,
              userId
            );
            if (marked.changes !== 1) abort('already_refunded');
          },
        }
      );
      if (out.ok) refunded += 1;
      else if (out.reason !== 'already_refunded') failed += 1;
    } catch (err) {
      failed += 1;
      log.error('giveaways', `could not refund the entry of ${userId} in #${g.id}:`, err.message);
    }
  }
  return { refunded, failed };
}

/**
 * Cancel a running giveaway: nobody wins, and everybody who paid an entry fee gets it back. It can be
 * run again on a giveaway that is already cancelled: that finishes the refunds that are still open
 * (`resumed: true`), so "run it again" always works when some failed. A giveaway that was drawn
 * cannot be cancelled.
 * @returns {Promise<{ ok: boolean, reason?: string, refunded?: number, failed?: number, resumed?: boolean }>}
 */
export async function cancelGiveaway(id) {
  const g = await getGiveaway(id);
  if (!g) return { ok: false, reason: 'not-found' };
  // One statement ends and cancels it, and takes the row lock the entry transactions wait on.
  const claimed = await claimGiveawayCancel(id);
  if (!claimed && !g.cancelled) return { ok: false, reason: 'already-ended' };
  const { refunded, failed } = await refundCancelledEntries(g);
  const guild = guildByKey(g.guild_id);
  const channel = guild
    ? (guild.channels.cache.get(g.channel_id) ?? (await guild.channels.fetch(g.channel_id).catch(() => null)))
    : null;
  if (claimed && channel?.isTextBased?.() && g.message_id) {
    const fresh = await getGiveaway(id);
    const msg = await channel.messages.fetch(g.message_id).catch(() => null);
    if (msg)
      await msg
        .edit(buildGiveawayPayload(fresh, { entryCount: await giveawayEntryCount(id) }))
        .catch(() => {});
  }
  return { ok: true, refunded, failed, resumed: !claimed };
}

/**
 * The money work a crash can leave open, finished by the sweep: refunds of cancelled giveaways, and
 * currency prizes of recent draws. Both are safe to repeat (a marker per entry, a row per prize).
 */
export async function completeGiveawayMoney(now = Date.now()) {
  for (const g of await cancelledWithUnrefunded(20)) await refundCancelledEntries(g);
  for (const g of await giveawaysWithUnpaidPrizes(now - PRIZE_SWEEP_WINDOW_MS, 20)) {
    const economy = normaliseEconomyConfig((await getGuildModule(g.guild_id, 'economy')).config);
    const { complete } = await payPrizes(g, g.wonIds, economy);
    if (complete) await markGiveawayPrizesPaid(g.id);
  }
}

/** How far back (from the last draw or reroll) the sweep looks for draws whose prizes were not all paid. */
const PRIZE_SWEEP_WINDOW_MS = 7 * 86_400_000;

registerComponent('giveaways', 'gaw:enter:', (interaction) =>
  handleEnter(interaction, Number(interaction.customId.slice('gaw:enter:'.length)))
);

// --- expiry loop ----------------------------------------------------

const TICK_MS = 20_000;
async function tick() {
  if (!allClientsReady()) return;
  for (const g of await dueGiveaways(Date.now())) {
    if ((await isModuleEnabled(g.guild_id, 'giveaways')) && Boolean(guildByKey(g.guild_id))) {
      endGiveaway(g.id).catch((err) => log.error('giveaways', 'auto-end failed:', err.message));
    } else {
      await markGiveawayEnded(g.id, []); // module off / bot gone — just close it
    }
  }
}
every('giveaways', TICK_MS, () => {
  tick().catch((err) => log.error('giveaways', 'tick failed:', err.message));
});
every('giveaways', 60_000, () =>
  completeGiveawayMoney().catch((err) => log.error('giveaways', 'money sweep failed:', err.message))
);
