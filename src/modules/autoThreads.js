// Auto threads: every new post in a chosen channel gets its own thread, named from a template.
//
// config shape (see normaliseAutoThreadsConfig):
//   { rules: [ {
//     id, channelId,
//     nameTemplate,              // {author} {date} {words}, see lib/autoThreadName.js
//     archiveMinutes,            // 60 | 1440 | 4320 | 10080
//     onlyWithAttachments,       // the post must carry a file ...
//     onlyWithLinks,             // ... or a link (with both on, either one is enough)
//     skipBots, skipStaff, staffRoleIds,
//     firstMessage,              // optional first message in the thread; {author} becomes a mention
//     slowmodeSeconds,           // slowmode inside the thread, 0 = off
//   } ] }
//
// Several rules may point at the same channel; the first one that applies to a post wins. Discord
// only: Fluxer has no threads (platform/capabilities.js), so on a Fluxer server nothing happens.
import { ChannelType } from 'discord.js';
import { on } from './dispatch.js';
import { log } from '../lib/log.js';
import { guildSupports } from '../platform/platformOf.js';
import {
  ARCHIVE_MINUTES,
  DEFAULT_ARCHIVE_MINUTES,
  DEFAULT_TEMPLATE,
  cut,
  renderThreadName,
} from '../lib/autoThreadName.js';

export { ARCHIVE_MINUTES };

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  rules: { maxItems: 25 },
  'rules[].nameTemplate': { maxLength: 100 },
  'rules[].staffRoleIds': { maxItems: 25 },
  'rules[].firstMessage': { maxLength: 2000 },
  'rules[].slowmodeSeconds': { min: 0, max: 21600 },
};

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const idList = (v, max) => [...new Set((Array.isArray(v) ? v : []).filter((x) => isId(x)))].slice(0, max);
const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

/** Coerce stored or submitted config into the canonical shape. Rules without a valid channel are dropped. */
export function normaliseAutoThreadsConfig(raw = {}) {
  const seen = new Set();
  const rules = (Array.isArray(raw?.rules) ? raw.rules : [])
    .slice(0, LIMITS.rules.maxItems)
    .map((r, i) => {
      const rule = r && typeof r === 'object' ? r : {};
      let id = String(rule.id ?? '')
        .replace(/[^\w-]/g, '')
        .slice(0, 40);
      if (!id || seen.has(id)) id = `r${i + 1}`;
      while (seen.has(id)) id += 'x';
      seen.add(id);
      const archive = Number(rule.archiveMinutes);
      return {
        id,
        channelId: isId(rule.channelId) ? rule.channelId : '',
        nameTemplate:
          cut(String(rule.nameTemplate ?? '').trim(), LIMITS['rules[].nameTemplate'].maxLength).trim() ||
          DEFAULT_TEMPLATE,
        archiveMinutes: ARCHIVE_MINUTES.includes(archive) ? archive : DEFAULT_ARCHIVE_MINUTES,
        onlyWithAttachments: rule.onlyWithAttachments === true,
        onlyWithLinks: rule.onlyWithLinks === true,
        skipBots: rule.skipBots !== false,
        skipStaff: rule.skipStaff === true,
        staffRoleIds: idList(rule.staffRoleIds, LIMITS['rules[].staffRoleIds'].maxItems),
        firstMessage: cut(String(rule.firstMessage ?? '').trim(), LIMITS['rules[].firstMessage'].maxLength),
        slowmodeSeconds: clampInt(
          rule.slowmodeSeconds,
          LIMITS['rules[].slowmodeSeconds'].min,
          LIMITS['rules[].slowmodeSeconds'].max,
          0
        ),
      };
    })
    .filter((r) => r.channelId);
  return { rules };
}

// --- which posts get a thread -------------------------------------------------------------------

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false;
  }
};

/**
 * Staff = Administrator or Manage Server, or one of the rule's staff roles.
 * @param {{ permissions?: any, roles?: { cache?: { has(id: string): boolean } } } | null} member
 * @param {{ staffRoleIds?: string[] }} rule
 */
export function isStaffMember(member, rule) {
  if (!member) return false;
  if (['Administrator', 'ManageGuild'].some((p) => hasPermission(member.permissions, p))) return true;
  return (rule.staffRoleIds ?? []).some((id) => member.roles?.cache?.has?.(id));
}

/** Whether the text holds a link. */
export const hasLink = (content) => /https?:\/\/\S+/i.test(String(content ?? ''));

/**
 * Why a rule does not take this post, or null when it does.
 * @returns {null | 'bot' | 'staff' | 'no-attachment-or-link'}
 */
export function ruleSkipReason(rule, message) {
  if (rule.skipBots && (message.author?.bot || message.webhookId)) return 'bot';
  if (rule.skipStaff && isStaffMember(message.member, rule)) return 'staff';
  if (rule.onlyWithAttachments || rule.onlyWithLinks) {
    const attached = (message.attachments?.size ?? 0) > 0;
    const linked = hasLink(message.content);
    const ok = (rule.onlyWithAttachments && attached) || (rule.onlyWithLinks && linked);
    if (!ok) return 'no-attachment-or-link';
  }
  return null;
}

/** The first rule for this channel that takes the post, or null. */
export function matchRule(rules, message) {
  return rules.find((r) => r.channelId === message.channelId && ruleSkipReason(r, message) === null) ?? null;
}

/** The message in the thread's first post: `{author}` becomes a mention of the poster. */
export function renderFirstMessage(template, authorId) {
  return cut(String(template ?? '').replace(/\{author\}/gi, `<@${authorId}>`), 2000);
}

// --- safety: one warning per hour, one thread per two seconds ----------------------------------

export const WARN_EVERY_MS = 60 * 60 * 1000;
export const THREAD_EVERY_MS = 2000;

const warnedAt = new Map(); // `${channelId}:${problem}` -> timestamp
const startedAt = new Map(); // channelId -> timestamp of the last thread
const dropped = new Map(); // channelId -> posts dropped since the last thread

/** A warning at most once per channel and problem per hour. Returns whether it was logged. */
function warnOnce(channelId, problem, text) {
  const key = `${channelId}:${problem}`;
  const now = Date.now();
  const last = warnedAt.get(key);
  if (last !== undefined && now - last < WARN_EVERY_MS) return false;
  warnedAt.set(key, now);
  log.warn('auto-threads', text);
  return true;
}

/** Forget the throttles (tests). */
export function resetAutoThreads() {
  warnedAt.clear();
  startedAt.clear();
  dropped.clear();
}

const NEEDED = ['CreatePublicThreads', 'SendMessagesInThreads'];
const THREAD_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
// Discord: 10008 Unknown Message (deleted already), 160004 a thread exists for this message.
const QUIET_CODES = new Set([10008, 160004]);

/** Handle one new message. */
async function onMessage(message, rawConfig, guildId) {
  const guild = message.guild;
  if (!guild || message.system) return; // a DM, or a join / pin / boost notice
  if (!guildSupports(guild, 'threads')) return; // Fluxer
  const channel = message.channel;
  if (!channel || (typeof channel.isThread === 'function' && channel.isThread())) return;
  if (!THREAD_CHANNELS.has(channel.type)) return; // forums make their own threads
  if (message.hasThread) return;
  // Sylo's own posts (alerts, welcomes, a sticky message) never open a thread.
  if (message.author?.id && message.author.id === message.client?.user?.id) return;

  const rule = matchRule(normaliseAutoThreadsConfig(rawConfig).rules, message);
  if (!rule) return;

  const me = guild.members?.me;
  if (!me || !channel.permissionsFor(me)?.has(NEEDED)) {
    warnOnce(
      channel.id,
      'permissions',
      `no threads in #${channel.name ?? channel.id} (${guildId}): Sylo needs Create Public Threads and Send Messages in Threads there`
    );
    return;
  }

  const now = Date.now();
  const last = startedAt.get(channel.id);
  if (last !== undefined && now - last < THREAD_EVERY_MS) {
    const count = (dropped.get(channel.id) ?? 0) + 1;
    dropped.set(channel.id, count);
    log.debug('auto-threads', `rate limit: dropped ${count} post(s) in ${channel.id} since the last thread`);
    return;
  }
  startedAt.set(channel.id, now);
  const droppedBefore = dropped.get(channel.id) ?? 0;
  dropped.delete(channel.id);
  if (droppedBefore) log.debug('auto-threads', `${droppedBefore} post(s) were dropped in ${channel.id}`);

  const authorName =
    message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? 'someone';
  const name = renderThreadName(rule.nameTemplate, {
    author: authorName,
    createdAt: message.createdTimestamp ?? now,
    content: message.content,
  });

  let thread;
  try {
    thread = await message.startThread({
      name,
      autoArchiveDuration: rule.archiveMinutes,
      reason: `Auto threads (rule ${rule.id})`,
    });
  } catch (err) {
    if (QUIET_CODES.has(err?.code)) {
      log.debug('auto-threads', `no thread for ${message.id}:`, err.message);
    } else {
      warnOnce(
        channel.id,
        'start',
        `could not start a thread in ${channel.id} (${guildId}): ${err?.message}`
      );
    }
    return;
  }
  if (!thread) return;

  // Both extras are a nicety: the thread already exists, so a failure here only costs the extra.
  if (rule.slowmodeSeconds > 0) {
    try {
      await thread.setRateLimitPerUser?.(rule.slowmodeSeconds, 'Auto threads');
    } catch (err) {
      log.debug('auto-threads', `no slowmode in thread ${thread.id}:`, err?.message);
    }
  }
  if (rule.firstMessage) {
    try {
      await thread.send({
        content: renderFirstMessage(rule.firstMessage, message.author.id),
        allowedMentions: { parse: [], users: [message.author.id] },
      });
    } catch (err) {
      log.debug('auto-threads', `no first message in thread ${thread.id}:`, err?.message);
    }
  }
}

// `messageCreateAny` (not `messageCreate`) because a rule may ask for bots too (skipBots off).
on('auto-threads', 'messageCreateAny', onMessage);

export { onMessage as handleAutoThreadMessage };
