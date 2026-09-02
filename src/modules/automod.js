// Auto-moderation module: scans messages against a set of filters and acts on
// the first match (delete, warn, or timeout). Runs on message create and edit.
//
// config shape (see normaliseAutomodConfig for the canonical form):
//   {
//     deleteMessage: boolean,          // remove the offending message
//     timeoutMinutes: number,          // used by the 'timeout' action
//     exemptChannels: string[],        // channel ids automod ignores
//     exemptRoles: string[],           // role ids automod never acts on
//     rules: {
//       invites:  { enabled, action },
//       links:    { enabled, action, allowed: string[] },  // allowed domains
//       spam:     { enabled, action, max, seconds },
//       mentions: { enabled, action, max },
//       caps:     { enabled, action, minLength, percent },
//       words:    { enabled, action, list: string[] },
//     },
//     native: {                        // push mappable rules to Discord AutoMod
//       enabled: boolean,              // master switch
//       words, mentions, spam: boolean,// mirror that rule natively too
//       presets: string[],             // subset of PRESET_KEYS
//     }
//   }
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { PRESET_KEYS } from '../bot/lib/automodSync.js';
import { on } from './dispatch.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget } from '../bot/lib/moderation.js';
import { addWarning } from '../db/warnings.js';
import { applyWarnThresholds } from './moderation.js';
import { log } from '../lib/log.js';

export const AUTOMOD_ACTIONS = ['delete', 'warn', 'timeout'];

/** [key, label, hint] for each filter — drives the settings panel. */
export const AUTOMOD_RULES = [
  ['words', 'Bad words', 'Blocks messages containing any listed word or phrase.'],
  ['repeat', 'Repeated text', 'Blocks messages that are mostly one repeated word or character.'],
  ['invites', 'Server invites', 'Blocks messages containing a discord.gg / invite link.'],
  ['links', 'External links', 'Blocks URLs. List allowed domains to permit only those.'],
  ['caps', 'Excessive caps', 'Messages that are mostly uppercase.'],
  ['emojis', 'Excessive emojis', 'More than N emojis in a single message.'],
  ['spoilers', 'Excessive spoilers', 'More than N spoiler tags in a single message.'],
  ['mentions', 'Excessive mentions', 'More than N user/role mentions in a single message.'],
  ['zalgo', 'Zalgo', 'Corrupted / combining-character text spam.'],
  ['spam', 'Anti-spam', 'One user sending too many messages in a short window.'],
];

const RULE_KEYS = AUTOMOD_RULES.map(([k]) => k);
const AUTOMOD_COLOR = 0xe5b567;

const INVITE_RE = /(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const URL_RE = /\bhttps?:\/\/[^\s/$.?#][^\s]*/gi;

// --- config normalisation ------------------------------------------------

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const termList = (v) =>
  [
    ...new Set(
      (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 200);
const action = (v) => (AUTOMOD_ACTIONS.includes(v) ? v : 'delete');

/** [key, label] for the checks that have a native Discord AutoMod equivalent. */
export const NATIVE_MAPPABLE = [
  ['words', 'Bad words'],
  ['mentions', 'Excessive mentions'],
  ['spam', 'Anti-spam'],
];
export { PRESET_KEYS };

function normaliseNative(n = {}) {
  const presets = (Array.isArray(n.presets) ? n.presets : [n.presets]).filter((p) => PRESET_KEYS.includes(p));
  return {
    enabled: Boolean(n.enabled),
    words: Boolean(n.words),
    mentions: Boolean(n.mentions),
    spam: Boolean(n.spam),
    presets: [...new Set(presets)],
  };
}

/** Coerce any stored/submitted config into the canonical shape. */
export function normaliseAutomodConfig(raw = {}) {
  const r = raw.rules || {};
  return {
    deleteMessage: raw.deleteMessage !== false,
    timeoutMinutes: clampInt(raw.timeoutMinutes, 1, 40320, 10),
    exemptChannels: idList(raw.exemptChannels),
    exemptRoles: idList(raw.exemptRoles),
    native: normaliseNative(raw.native),
    rules: {
      invites: { enabled: Boolean(r.invites?.enabled), action: action(r.invites?.action) },
      links: {
        enabled: Boolean(r.links?.enabled),
        action: action(r.links?.action),
        allowed: termList(r.links?.allowed).map((d) => d.replace(/^www\./, '')),
      },
      spam: {
        enabled: Boolean(r.spam?.enabled),
        action: action(r.spam?.action),
        max: clampInt(r.spam?.max, 2, 30, 5),
        seconds: clampInt(r.spam?.seconds, 1, 60, 5),
      },
      mentions: {
        enabled: Boolean(r.mentions?.enabled),
        action: action(r.mentions?.action),
        max: clampInt(r.mentions?.max, 1, 50, 5),
      },
      caps: {
        enabled: Boolean(r.caps?.enabled),
        action: action(r.caps?.action),
        minLength: clampInt(r.caps?.minLength, 4, 200, 10),
        percent: clampInt(r.caps?.percent, 50, 100, 70),
      },
      words: {
        enabled: Boolean(r.words?.enabled),
        action: action(r.words?.action),
        list: termList(r.words?.list),
      },
      emojis: {
        enabled: Boolean(r.emojis?.enabled),
        action: action(r.emojis?.action),
        max: clampInt(r.emojis?.max, 1, 50, 8),
      },
      spoilers: {
        enabled: Boolean(r.spoilers?.enabled),
        action: action(r.spoilers?.action),
        max: clampInt(r.spoilers?.max, 1, 30, 4),
      },
      zalgo: { enabled: Boolean(r.zalgo?.enabled), action: action(r.zalgo?.action) },
      repeat: { enabled: Boolean(r.repeat?.enabled), action: action(r.repeat?.action) },
    },
  };
}

// --- spam window tracking ---------------------------------------------------

/** `${guildId}:${userId}` -> recent message timestamps (ms). */
const recent = new Map();

function bumpFlood(key, now, windowMs) {
  const kept = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  kept.push(now);
  recent.set(key, kept);
  return kept.length;
}

// Sweep stale entries so the map cannot grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, arr] of recent) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) recent.set(k, kept);
    else recent.delete(k);
  }
}, 60_000).unref();

// --- detection -----------------------------------------------------------

function anyEnabled(config) {
  const r = config?.rules;
  return Boolean(r) && RULE_KEYS.some((k) => r[k]?.enabled);
}

function isExempt(member, channelId, cfg) {
  // Administrators (and the owner) are always skipped — like Discord's own
  // AutoMod. Regular moderators are only skipped via the exempt-roles list.
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.exemptChannels.includes(channelId)) return true;
  return cfg.exemptRoles.some((r) => member.roles.cache.has(r));
}

export function containsInvite(content) {
  return INVITE_RE.test(content);
}

export function disallowedLink(content, allowed = []) {
  for (const match of content.matchAll(URL_RE)) {
    let host;
    try {
      host = new URL(match[0]).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (allowed.length === 0) return host;
    if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) return host;
  }
  return null;
}

export function exceedsCaps(content, rule) {
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length < rule.minLength) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return (upper / letters.length) * 100 >= rule.percent;
}

const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;
// Ranges of combining marks (diacriticals, Cyrillic, Ethiopic, Balinese, supplement,
// symbols, half-marks). Zalgo detection deliberately counts *lone* combining marks,
// which is exactly what no-misleading-character-class flags.
// prettier-ignore
// eslint-disable-next-line no-misleading-character-class
const ZALGO_RE = /[\u0300-\u036F\u0483-\u0489\u135D-\u135F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/gu;

export function countEmojis(s) {
  return (String(s).match(EMOJI_RE) || []).length;
}
export function countSpoilers(s) {
  return (String(s).match(/\|\|[^|]+\|\|/g) || []).length;
}
export function isZalgo(s) {
  const str = String(s);
  if (str.length < 8) return false;
  const marks = (str.match(ZALGO_RE) || []).length;
  return marks / str.length > 0.28;
}
export function isRepeatedText(s) {
  const t = String(s).trim();
  if (t.length < 12) return false;
  if (/(.)\1{9,}/u.test(t)) return true; // 10+ of the same character in a row
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 6 && new Set(words).size / words.length <= 0.34) return true;
  return false;
}

export function matchWord(content, list) {
  const lc = content.toLowerCase();
  for (const term of list) {
    if (/^[\p{L}\p{N}]+$/u.test(term)) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(content))
        return term;
    } else if (lc.includes(term)) {
      return term;
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {import('discord.js').Message} message
 * @param {object} config  stored module config
 * @param {{ flood: boolean }} opts  flood check only makes sense on new messages
 */
async function scan(message, config, opts) {
  if (message.partial || message.author?.bot || !message.content || !message.guild) return;
  if (!anyEnabled(config)) return;
  const cfg = normaliseAutomodConfig(config);

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member, message.channelId, cfg)) return;

  const { rules } = cfg;
  const content = message.content;

  if (rules.invites.enabled && INVITE_RE.test(content)) {
    return act(message, member, rules.invites, 'Discord invite', cfg);
  }
  if (rules.links.enabled) {
    const host = disallowedLink(content, rules.links.allowed);
    if (host) return act(message, member, rules.links, `link (${host})`, cfg);
  }
  if (rules.mentions.enabled) {
    const count =
      message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    if (count > rules.mentions.max) {
      return act(message, member, rules.mentions, `${count} mentions`, cfg);
    }
  }
  if (rules.caps.enabled && exceedsCaps(content, rules.caps)) {
    return act(message, member, rules.caps, 'excessive caps', cfg);
  }
  if (rules.emojis.enabled) {
    const n = countEmojis(content);
    if (n > rules.emojis.max) return act(message, member, rules.emojis, `${n} emojis`, cfg);
  }
  if (rules.spoilers.enabled) {
    const n = countSpoilers(content);
    if (n > rules.spoilers.max) return act(message, member, rules.spoilers, `${n} spoilers`, cfg);
  }
  if (rules.zalgo.enabled && isZalgo(content)) {
    return act(message, member, rules.zalgo, 'zalgo text', cfg);
  }
  if (rules.repeat.enabled && isRepeatedText(content)) {
    return act(message, member, rules.repeat, 'repeated text', cfg);
  }
  if (rules.words.enabled) {
    const hit = matchWord(content, rules.words.list);
    if (hit) return act(message, member, rules.words, `banned word "${hit}"`, cfg);
  }
  if (opts.flood && rules.spam.enabled) {
    const key = `${message.guildId}:${message.author.id}`;
    const n = bumpFlood(key, Date.now(), rules.spam.seconds * 1000);
    if (n > rules.spam.max) return act(message, member, rules.spam, 'message flood', cfg);
  }
}

async function act(message, member, rule, label, cfg) {
  const guild = message.guild;
  const removed = cfg.deleteMessage && message.deletable;
  if (removed) await message.delete().catch(() => {});

  const reason = `Automod: ${label}`;
  const outcome = [removed ? 'message deleted' : 'flagged'];
  let notified = null; // null = no DM attempted (plain delete)

  try {
    if (rule.action === 'warn') {
      const { count } = addWarning({
        guildId: guild.id,
        userId: member.id,
        moderatorId: 'automod',
        reason,
      });
      outcome.push(`warned (#${count})`);
      notified = await notifyTarget(member.user, {
        guildName: guild.name,
        action: 'warned',
        reason,
        extra: `This is warning #${count}. Triggered automatically by Auto-moderation.`,
      });
      await applyWarnThresholds(guild, member.user, count, 'Automod');
    } else if (rule.action === 'timeout' && member.moderatable) {
      await member.timeout(cfg.timeoutMinutes * 60_000, reason);
      outcome.push(`timed out ${cfg.timeoutMinutes}m`);
      notified = await notifyTarget(member.user, {
        guildName: guild.name,
        action: 'timed out',
        reason,
        extra: `Duration: ${cfg.timeoutMinutes} minute(s). Triggered automatically by Auto-moderation.`,
      });
    }
  } catch (err) {
    log.error('module:automod', 'action failed:', err.message);
  }

  const preview = message.content.length > 300 ? `${message.content.slice(0, 299)}…` : message.content;
  const embed = new EmbedBuilder()
    .setColor(AUTOMOD_COLOR)
    .setTitle('Automod')
    .setDescription(`${member.user.tag} (\`${member.id}\`) in <#${message.channelId}>`)
    .addFields(
      { name: 'Rule', value: label, inline: true },
      { name: 'Action', value: outcome.join(' · '), inline: true },
      { name: 'Message', value: preview || '*empty*' }
    );
  if (notified !== null) {
    embed.addFields({
      name: 'Notified',
      value: notified ? 'Yes (DM sent)' : 'No (DMs closed)',
      inline: true,
    });
  }
  embed.setTimestamp(Date.now());
  await postModLog(guild, embed);
}

on('automod', 'messageCreate', (message, config) => scan(message, config, { flood: true }));
on('automod', 'messageUpdate', (payload, config) => scan(payload.new, config, { flood: false }));
