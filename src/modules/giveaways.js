// Giveaways: `/giveaway start` posts an embed with an "Enter" button; a
// background loop draws winners at the end time. `/giveaway reroll` and `end`,
// plus the dashboard, call endGiveaway() directly.
//
// config shape: { ping: 'none' | 'here' | 'everyone', dmWinners: boolean }
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  getGiveaway,
  dueGiveaways,
  markGiveawayEnded,
  setGiveawayWinners,
  addGiveawayEntry,
  removeGiveawayEntry,
  hasGiveawayEntry,
  giveawayEntryCount,
  giveawayEntrantIds,
} from '../db/giveaways.js';
import { log } from '../lib/log.js';

export const MIN_MS = 60_000; // 1 minute
export const MAX_MS = 60 * 86_400_000; // 60 days
export const MAX_WINNERS = 20;
const ACCENT = 0xf0b232;

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
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle(`🎉 ${g.prize}`).setTimestamp(g.created_at || Date.now());

  if (!g.ended) {
    embed.setDescription(
      [
        `Click **🎉 Enter** below to join.`,
        '',
        `Ends: <t:${endTs}:R>  ·  <t:${endTs}:f>`,
        `Winners: **${g.winners}**`,
        g.required_role_id ? `Requires: <@&${g.required_role_id}>` : null,
        `Hosted by: <@${g.host_id}>`,
      ]
        .filter(Boolean)
        .join('\n')
    );
    embed.setFooter({ text: `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}` });
  } else {
    const won = g.wonIds || [];
    embed.setColor(0x4f545c).setDescription(
      [
        won.length ? `Winner${won.length === 1 ? '' : 's'}: ${won.map((id) => `<@${id}>`).join(', ')}` : 'No valid entries — no winner drawn.',
        '',
        `Ended: <t:${endTs}:R>`,
        `Hosted by: <@${g.host_id}>`,
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
  const g = getGiveaway(id);
  if (!g) return { ok: false, reason: 'not-found' };

  const guild = runtime.client?.guilds.cache.get(g.guild_id);
  if (!guild) {
    markGiveawayEnded(id, []);
    return { ok: false, reason: 'no-guild' };
  }
  const channel = guild.channels.cache.get(g.channel_id) ?? (await guild.channels.fetch(g.channel_id).catch(() => null));

  // Eligible = entrants still in the guild (and still holding the required role).
  const entrants = giveawayEntrantIds(id);
  const exclude = new Set(opts.rerollCount ? g.wonIds : []);
  const eligible = [];
  for (const uid of entrants) {
    if (exclude.has(uid)) continue;
    const member = guild.members.cache.get(uid) ?? (await guild.members.fetch(uid).catch(() => null));
    if (!member) continue;
    if (g.required_role_id && !member.roles.cache.has(g.required_role_id)) continue;
    eligible.push(uid);
  }

  const count = opts.rerollCount ? Math.max(1, Math.min(opts.rerollCount, MAX_WINNERS)) : g.winners;
  const winners = pickWinners(eligible, count);

  if (opts.rerollCount) setGiveawayWinners(id, winners);
  else markGiveawayEnded(id, winners);

  const fresh = getGiveaway(id);
  const entryCount = giveawayEntryCount(id);

  if (channel?.isTextBased?.() && g.message_id) {
    const msg = await channel.messages.fetch(g.message_id).catch(() => null);
    if (msg) await msg.edit(buildGiveawayPayload(fresh, { entryCount })).catch(() => {});
  }

  if (channel?.isTextBased?.()) {
    const cfg = normaliseGiveawaysConfig(getGuildModule(g.guild_id, 'giveaways').config);
    const lead = cfg.ping === 'everyone' ? '@everyone ' : cfg.ping === 'here' ? '@here ' : '';
    const body = winners.length
      ? `${lead}🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(', ')} — you won **${g.prize}**!`
      : `Nobody entered **${g.prize}**, so there is no winner.`;
    await channel
      .send({
        content: body,
        allowedMentions: {
          users: winners,
          parse: cfg.ping === 'everyone' ? ['everyone'] : [],
        },
      })
      .catch(() => {});

    if (cfg.dmWinners && winners.length) {
      for (const w of winners) {
        const user = await runtime.client.users.fetch(w).catch(() => null);
        await user
          ?.send(`You won **${g.prize}** in ${guild.name}! 🎉`)
          .catch(() => {});
      }
    }
  }

  return { ok: true, winners };
}

// --- entry button -----------------------------------------------------

async function handleEnter(interaction, id) {
  const g = getGiveaway(id);
  if (!g || g.ended) {
    return interaction.reply({ content: 'This giveaway has ended.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'giveaways')) {
    return interaction.reply({ content: 'Giveaways are disabled in this server.', flags: MessageFlags.Ephemeral });
  }
  if (g.required_role_id && !interaction.member.roles.cache.has(g.required_role_id)) {
    return interaction.reply({
      content: `You need <@&${g.required_role_id}> to enter this giveaway.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  let joined;
  if (hasGiveawayEntry(id, interaction.user.id)) {
    removeGiveawayEntry(id, interaction.user.id);
    joined = false;
  } else {
    addGiveawayEntry(id, interaction.user.id);
    joined = true;
  }

  // Refresh the entry count on the message (best-effort, non-blocking).
  const entryCount = giveawayEntryCount(id);
  interaction.message
    .edit(buildGiveawayPayload(getGiveaway(id), { entryCount }))
    .catch(() => {});

  return interaction.reply({
    content: joined ? "You're in! 🎉  Click again to leave." : "You've left this giveaway.",
    flags: MessageFlags.Ephemeral,
  });
}

/** @param {import('discord.js').Client} client */
export function registerGiveawayComponentHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('gaw:enter:')) return;
    try {
      await handleEnter(interaction, Number(interaction.customId.slice('gaw:enter:'.length)));
    } catch (err) {
      log.error('giveaways', 'entry button failed:', err.message);
      if (interaction.isRepliable() && !interaction.replied) {
        interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

// --- expiry loop ----------------------------------------------------

const TICK_MS = 20_000;
const timer = setInterval(() => {
  if (!runtime.client?.isReady()) return;
  for (const g of dueGiveaways(Date.now())) {
    if (isModuleEnabled(g.guild_id, 'giveaways') && runtime.client.guilds.cache.has(g.guild_id)) {
      endGiveaway(g.id).catch((err) => log.error('giveaways', 'auto-end failed:', err.message));
    } else {
      markGiveawayEnded(g.id, []); // module off / bot gone — just close it
    }
  }
}, TICK_MS);
timer.unref();
