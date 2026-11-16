// Honeypot: trap channels and trap messages that punish whoever posts in /
// reacts to them. Any real member interacting with one is an unambiguous
// automation signal (scrapers/raid bots that join, opt into every role, then
// DM the member list) — there is no grace period, only an Administrator/
// immune-role exemption.
//
// config shape (see normaliseHoneypotConfig for the canonical form):
//   {
//     exemptRoles: string[],
//     channels: [ { channelId, action, timeoutMinutes, deleteMessage, triggerCount } ],
//     messages: [ { channelId, messageId, bait, action, timeoutMinutes, triggerCount } ],
//   }
// triggerCount is bot-managed — bumped each time that row actually punishes
// someone, and (for message rows) shown live in the trap message itself,
// e.g. "Bans: 14" — never form-editable.
import { guildKey } from '../platform/platformOf.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { markModerated } from './lib/messageModeration.js';
import { getGuildModule, setGuildModule } from '../db/modules.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget, MOD_COLOR } from '../bot/lib/moderation.js';
import { addCase } from '../db/modCases.js';
import { clearTempBan } from '../db/tempBans.js';
import { recordHoneypotCatch } from '../db/honeypotCatches.js';
import { log } from '../lib/log.js';
import { isMessageGone } from '../platform/messageErrors.js';

export const HONEYPOT_ACTIONS = ['kick', 'timeout', 'ban'];
const ACTION_LABELS = { kick: 'Kicks', timeout: 'Timeouts', ban: 'Bans' };
const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord's own cap

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  channels: { maxItems: 25 },
  'channels[].timeoutMinutes': { min: 1, max: 40320 },
  messages: { maxItems: 25 },
  'messages[].bait': { maxLength: 500 },
  'messages[].timeoutMinutes': { min: 1, max: 40320 },
};
const CH_TIMEOUT = LIMITS['channels[].timeoutMinutes'];
const MSG_TIMEOUT = LIMITS['messages[].timeoutMinutes'];

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const action = (v) => (HONEYPOT_ACTIONS.includes(v) ? v : 'kick');

export function normaliseHoneypotConfig(raw = {}) {
  return {
    exemptRoles: idList(raw.exemptRoles),
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .map((c) => ({
        channelId: isId(c.channelId) ? c.channelId : '',
        action: action(c.action),
        timeoutMinutes: clampInt(c.timeoutMinutes, CH_TIMEOUT.min, CH_TIMEOUT.max, 10),
        deleteMessage: c.deleteMessage !== false,
        triggerCount: clampInt(c.triggerCount, 0, 10_000_000, 0),
      }))
      .filter((c, i, arr) => c.channelId && arr.findIndex((x) => x.channelId === c.channelId) === i)
      .slice(0, LIMITS.channels.maxItems),
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .map((m) => ({
        channelId: isId(m.channelId) ? m.channelId : '',
        messageId: isId(m.messageId) ? m.messageId : '',
        bait: String(m.bait ?? '').slice(0, LIMITS['messages[].bait'].maxLength),
        action: action(m.action),
        timeoutMinutes: clampInt(m.timeoutMinutes, MSG_TIMEOUT.min, MSG_TIMEOUT.max, 10),
        triggerCount: clampInt(m.triggerCount, 0, 10_000_000, 0),
      }))
      .filter((m, i, arr) => m.channelId && arr.findIndex((x) => x.channelId === m.channelId) === i)
      .slice(0, LIMITS.messages.maxItems),
  };
}

function isExempt(member, cfg) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return cfg.exemptRoles.some((r) => member.roles.cache.has(r));
}

// Fetching a message by id (needed to edit the live "Catches" count, and to
// tell "still there" from "deleted, re-post it" apart) needs Read Message
// History on top of the View/Send/Embed set ensureHoneypotMessages already
// checked for — a permission gap here used to be silently swallowed by the
// fetch's .catch(() => null), which then read as "the message was deleted"
// and posted a fresh duplicate on every config save, on top of the visible
// "Catches" count never updating (the exact symptom reported against #211).
const BAIT_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
function canManageBait(channel, me) {
  return Boolean(channel.permissionsFor(me)?.has(BAIT_PERMS));
}

/** The "Catches" text for one channel: the bait message row's count plus the
 * channel-trap row's count for the same channel, since both catch members in
 * that channel. One "Kicks: 3" line per action that has catches (the bait
 * row's action first). The two row kinds keep separate stored counts; the dashboard reads
 * those, so only the embed adds them together. */
function catchesText(messageRow, channelRow) {
  const totals = new Map();
  for (const r of [messageRow, channelRow]) {
    if (!r) continue;
    const act = ACTION_LABELS[r.action] ? r.action : 'kick';
    totals.set(act, (totals.get(act) ?? 0) + (r.triggerCount || 0));
  }
  // An action with no catches is left out (a second trap that never fired is
  // noise on a public message); a fresh trap still reads "Kicks: 0".
  const lines = [...totals].filter(([, n]) => n > 0);
  const shown = lines.length ? lines : [[[...totals.keys()][0], 0]];
  return shown.map(([act, n]) => `${ACTION_LABELS[act]}: ${n}`).join('\n');
}

/** The trap message's embed — a "Catches" field labeled by the punishment
 * action (e.g. "Bans: 14") so it reflects what actually happens here, not a
 * generic counter. Counts every catch in the channel: the bait row's, plus the
 * channel-trap row's when the same channel is also a trap channel. */
function baitEmbed(row, channelRow) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🍯 Do not send messages / react here')
    .setDescription(row.bait || '​')
    .addFields({ name: 'Catches', value: catchesText(row, channelRow) });
}

const channelRowFor = (config, channelId) =>
  (Array.isArray(config?.channels) ? config.channels : []).find((c) => c.channelId === channelId);

/** Apply the configured punishment, log a case, and post to the mod-log.
 * @returns {string|null} a short description of what happened, or null if
 *   nothing was (or could be) done — callers use this to decide whether to
 *   bump the row's trigger count.
 */
async function punish(guild, member, entry, reason) {
  let done = null;
  try {
    if (entry.action === 'timeout' && member.moderatable) {
      await member.timeout(Math.min(entry.timeoutMinutes * 60_000, MAX_TIMEOUT_MS), reason);
      done = `timed out for ${entry.timeoutMinutes}m`;
      await notifyTarget(member.user, { guildName: guild.name, action: 'timed out', reason });
    } else if (entry.action === 'kick' && member.kickable) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'kicked', reason });
      await member.kick(reason);
      done = 'kicked';
    } else if (entry.action === 'ban' && guild.members.me?.permissions.has('BanMembers')) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'banned', reason });
      await guild.bans.create(member.id, { reason });
      // A permanent ban now: an earlier temporary ban's timer must not lift it.
      await clearTempBan(guildKey(guild), member.id);
      done = 'banned';
    }
  } catch (err) {
    log.error('module:honeypot', 'punish failed:', err.message);
    return null;
  }
  if (!done) return null;

  const { caseNumber } = await addCase({
    guildId: guildKey(guild),
    userId: member.id,
    moderatorId: 'honeypot',
    action: entry.action,
    reason,
    detail: entry.action === 'timeout' ? `${entry.timeoutMinutes}m` : null,
  });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Honeypot triggered')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Case', value: `#${caseNumber}` },
      { name: 'User', value: `${member.user.tag} (\`${member.id}\`)` },
      { name: 'Action', value: done },
      { name: 'Trigger', value: reason }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
  return done;
}

// bumpHoneypotStat does a read-modify-write (fetch config, bump the count,
// save it back) — two triggers landing close enough together could both read
// before either writes and lose an increment. Chaining each call onto the
// previous one for the same guild, instead of letting them run concurrently,
// closes that without needing a real lock. The whole honeypot config is one
// stored value, so a channel-trap bump and a bait-message bump (separate rows)
// must queue behind each other too, not just bumps of the same row. Only the
// read-modify-write sits in the queue; the Discord calls that refresh the bait
// message run after it (see renderBait), so a slow edit never holds up the
// next catch's count.
const honeypotBumpQueue = new Map();

export async function bumpHoneypotStat(guild, kind, channelId) {
  const key = guildKey(guild);
  const run = (honeypotBumpQueue.get(key) ?? Promise.resolve()).then(() =>
    persistHoneypotBump(guild, kind, channelId)
  );
  // Swallow here so one failed bump doesn't jam the queue for the next
  // bump in the same guild — this call's own `await` still sees the rejection.
  honeypotBumpQueue.set(
    key,
    run.catch(() => {})
  );
  const hasBait = await run;
  if (hasBait) await renderBait(guild, channelId);
}

/**
 * Bumps a row's triggerCount and persists it — re-reads the config fresh
 * (not the stale copy the dispatch handler was called with) so a rapid
 * back-to-back trigger doesn't clobber the other's count.
 * @returns {boolean} whether the channel has a live bait message to refresh,
 *   whichever kind of row was bumped.
 */
async function persistHoneypotBump(guild, kind, channelId) {
  const fresh = (await getGuildModule(guildKey(guild), 'honeypot')).config;
  const list = Array.isArray(fresh[kind]) ? fresh[kind] : [];
  const row = list.find((r) => r.channelId === channelId);
  if (!row) return false;
  row.triggerCount = (row.triggerCount || 0) + 1;
  await setGuildModule(guildKey(guild), 'honeypot', { config: { ...fresh, [kind]: list } });
  return Boolean(baitRowFor(fresh, channelId)?.messageId);
}

const baitRowFor = (config, channelId) =>
  (Array.isArray(config?.messages) ? config.messages : []).find((m) => m.channelId === channelId);

// One refresh of a channel's bait message at a time. A catch that lands while a
// refresh is running does not start a second one: it asks the running one to go
// round again, which re-reads the stored counts, so a burst of catches costs a
// few edits instead of one per catch and the last edit always shows the total.
const baitRenders = new Map();

function renderBait(guild, channelId) {
  const key = `${guildKey(guild)}:${channelId}`;
  const running = baitRenders.get(key);
  if (running) {
    running.again = true;
    return running.done;
  }
  const state = { again: false, done: null };
  state.done = (async () => {
    try {
      do {
        state.again = false;
        await renderBaitOnce(guild, channelId);
      } while (state.again);
    } catch (err) {
      log.error('module:honeypot', 'updating the live catch count failed:', err.message);
    } finally {
      baitRenders.delete(key);
    }
  })();
  baitRenders.set(key, state);
  return state.done;
}

// The "missing permissions" warning repeats on every catch in a raid, so it is
// logged at most once an hour per channel.
const PERM_WARN_INTERVAL_MS = 3_600_000;
const permWarnedAt = new Map();

/** Test hook: forget which channels already logged the permission warning. */
export function resetBaitPermWarnings() {
  permWarnedAt.clear();
}

/**
 * Re-renders the channel's live bait message from the stored counts, so its
 * visible "Bans: N" (or Kicks/Timeouts) count — the bait row's plus the
 * channel-trap row's — is never stale.
 */
async function renderBaitOnce(guild, channelId) {
  const fresh = (await getGuildModule(guildKey(guild), 'honeypot')).config;
  const baitRow = baitRowFor(fresh, channelId);
  if (!baitRow?.messageId) return;
  const channel =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return;
  if (!canManageBait(channel, guild.members.me)) {
    const warnKey = `${guildKey(guild)}:${channelId}`;
    if (Date.now() - (permWarnedAt.get(warnKey) ?? -Infinity) >= PERM_WARN_INTERVAL_MS) {
      permWarnedAt.set(warnKey, Date.now());
      log.warn(
        'module:honeypot',
        `missing permissions (need ${BAIT_PERMS.join(', ')}) to update the live catch count in #${channel.name ?? channelId}`
      );
    }
    return;
  }
  const existing = await channel.messages.fetch(baitRow.messageId).catch((err) => {
    log.error('module:honeypot', 'fetching the bait message failed:', err.message);
    return null;
  });
  if (!existing) return;
  await existing
    .edit({ embeds: [baitEmbed(baitRow, channelRowFor(fresh, channelId))] })
    .catch((err) => log.error('module:honeypot', 'updating the live catch count failed:', err.message));
}

/**
 * (Re)posts each configured trap message, editing it in place when it
 * already exists — same "bot owns the message, admin only edits the text"
 * pattern verification.js's ensureVerifyMessage uses, generalized to a list
 * of rows keyed by channelId instead of a single row.
 */
export async function ensureHoneypotMessages(guild, config) {
  const rows = Array.isArray(config.messages) ? config.messages : [];
  if (!rows.length) return;
  const me = guild.members.me;
  let changed = false;

  for (const row of rows) {
    if (!row.channelId) continue;
    const channel =
      guild.channels.cache.get(row.channelId) ??
      (await guild.channels.fetch(row.channelId).catch(() => null));
    if (!channel?.isTextBased()) continue;
    if (!canManageBait(channel, me)) {
      log.warn(
        'module:honeypot',
        `missing permissions (need ${BAIT_PERMS.join(', ')}) to manage the bait message in #${channel.name ?? row.channelId}`
      );
      continue;
    }

    if (row.messageId) {
      let existing = null;
      try {
        existing = await channel.messages.fetch(row.messageId);
      } catch (err) {
        // Only "it is gone" means post a new one. A timeout, a 5xx or missing access must not.
        if (!isMessageGone(err)) {
          log.error(
            'module:honeypot',
            'fetching the bait message failed, not posting a new one:',
            err.message
          );
          continue;
        }
      }
      if (existing) {
        await existing
          .edit({ embeds: [baitEmbed(row, channelRowFor(config, row.channelId))] })
          .catch((err) => log.error('module:honeypot', 'updating the bait message failed:', err.message));
        continue;
      }
    }
    const posted = await channel
      .send({ embeds: [baitEmbed(row, channelRowFor(config, row.channelId))] })
      .catch((err) => {
        log.error('module:honeypot', 'posting the bait message failed:', err.message);
        return null;
      });
    if (posted) {
      row.messageId = posted.id;
      changed = true;
    }
  }

  if (changed) {
    const fresh = (await getGuildModule(guildKey(guild), 'honeypot')).config;
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    const merged = {
      ...fresh,
      messages: (fresh.messages ?? []).map((m) => byChannel.get(m.channelId) ?? m),
    };
    await setGuildModule(guildKey(guild), 'honeypot', { config: merged });
  }
}

async function onTrapMessage(message, config) {
  if (message.partial || !message.guild) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.channels.length) return;
  const entry = cfg.channels.find((c) => c.channelId === message.channelId);
  if (!entry) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member, cfg)) return;

  markModerated(message); // a command posted in a trap channel must not run
  const done = await punish(message.guild, member, entry, 'Honeypot: message posted in trap channel');
  if (entry.deleteMessage && message.deletable) await message.delete().catch(() => {});
  if (done) {
    await bumpHoneypotStat(message.guild, 'channels', message.channelId);
    await recordHoneypotCatch(guildKey(message.guild), {
      userId: member.id,
      userTag: member.user.tag,
      kind: 'channel',
      channelId: message.channelId,
      action: entry.action,
    }).catch((err) => log.error('module:honeypot', 'catch log failed:', err.message));
  }
}

on('honeypot', 'messageCreate', onTrapMessage);
// A command posted in a trap channel is just as much a trap hit.
on('honeypot', 'commandMessageCreate', onTrapMessage);

on('honeypot', 'reactionAdd', async ({ reaction, user }, config) => {
  if (user.bot) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.messages.length) return;
  const entry = cfg.messages.find((m) => m.messageId === reaction.message.id);
  if (!entry) return;

  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || isExempt(member, cfg)) return;

  const done = await punish(guild, member, entry, 'Honeypot: reacted to trap message');
  if (done) {
    await bumpHoneypotStat(guild, 'messages', entry.channelId);
    await recordHoneypotCatch(guildKey(guild), {
      userId: member.id,
      userTag: member.user.tag,
      kind: 'message',
      channelId: entry.channelId,
      action: entry.action,
    }).catch((err) => log.error('module:honeypot', 'catch log failed:', err.message));
  }
});
