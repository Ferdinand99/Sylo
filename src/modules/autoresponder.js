// Autoresponder: automatically reply when a message matches a trigger phrase
// (Dyno-style). Unlike custom commands there is no prefix — any message that
// matches fires.
//
// config shape (see normaliseAutoresponder):
//   {
//     cooldownSeconds: number,          // per-channel, anti-spam
//     ignoreChannels: string[],
//     ignoreRoles: string[],
//     responders: [ {
//       trigger, match: 'contains'|'exact'|'startswith'|'wholeword',
//       response, embed: bool, embedColor, deleteTrigger: bool
//     } ]
//   }
import { on } from './dispatch.js';
import { buildCustomReply } from './customCommands.js';

export const AR_MATCH_MODES = ['contains', 'exact', 'startswith', 'wholeword'];
export const AR_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{channel}'];

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normaliseAutoresponder(raw = {}) {
  return {
    cooldownSeconds: clampInt(raw.cooldownSeconds, 0, 300, 2),
    ignoreChannels: idList(raw.ignoreChannels),
    ignoreRoles: idList(raw.ignoreRoles),
    responders: (Array.isArray(raw.responders) ? raw.responders : [])
      .map((r) => ({
        trigger: String(r.trigger ?? '').trim().slice(0, 200),
        match: AR_MATCH_MODES.includes(r.match) ? r.match : 'contains',
        response: String(r.response ?? '').slice(0, 2000),
        embed: Boolean(r.embed),
        embedColor: /^#?[0-9a-fA-F]{6}$/.test(r.embedColor ?? '') ? r.embedColor.replace('#', '') : '5b7cfa',
        deleteTrigger: Boolean(r.deleteTrigger),
      }))
      .filter((r) => r.trigger !== '' && r.response.trim() !== '')
      .slice(0, 100),
  };
}

/** Whether `content` matches `trigger` under `mode` (both compared case-insensitively). */
export function matchesTrigger(content, trigger, mode) {
  const c = content.toLowerCase();
  const t = trigger.toLowerCase();
  if (!t) return false;
  switch (mode) {
    case 'exact':
      return c.trim() === t;
    case 'startswith':
      return c.trimStart().startsWith(t);
    case 'wholeword':
      return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'u').test(c);
    case 'contains':
    default:
      return c.includes(t);
  }
}

// Per-channel cooldown so one busy trigger can't flood a channel.
const lastFire = new Map(); // `${guildId}:${channelId}` -> ts

on('autoresponder', 'messageCreate', async (message, rawConfig, guildId) => {
  if (message.author?.bot || !message.content || !message.member) return;
  const config = normaliseAutoresponder(rawConfig);
  if (config.responders.length === 0) return;

  if (config.ignoreChannels.includes(message.channelId)) return;
  if (config.ignoreRoles.some((r) => message.member.roles.cache.has(r))) return;

  const key = `${guildId}:${message.channelId}`;
  const now = Date.now();
  if (now - (lastFire.get(key) ?? 0) < config.cooldownSeconds * 1000) return;

  const hit = config.responders.find((r) => matchesTrigger(message.content, r.trigger, r.match));
  if (!hit) return;

  const me = message.guild.members.me;
  if (!message.channel.permissionsFor(me)?.has(['SendMessages', 'ViewChannel'])) return;
  lastFire.set(key, now);

  if (hit.deleteTrigger && message.deletable) {
    await message.delete().catch(() => {});
  }

  const payload = buildCustomReply(
    { response: hit.response, embed: hit.embed, embedTitle: '', embedColor: hit.embedColor },
    {
      userId: message.author.id,
      username: message.author.username,
      guildName: message.guild.name,
      channelId: message.channelId,
      args: '',
    }
  );
  await message.channel.send(payload).catch(() => {});
});
