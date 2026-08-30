// Leveling: members earn XP for chatting, level up on a MEE6-style curve, and
// can be granted roles at set levels.
//
// config shape (see normaliseLevelingConfig):
//   { cooldownSeconds, announce: 'channel'|'reply'|'dm'|'off', announceChannel,
//     announceMessage, noXpChannels: [], noXpRoles: [], stackRewards: bool,
//     rewards: [ { level, roleId } ] }
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { addXp } from '../db/leveling.js';
import { sendToChannel } from './lib/send.js';

export const ANNOUNCE_MODES = ['channel', 'reply', 'dm', 'off'];
const DEFAULT_MESSAGE = '🎉 {user} just reached **level {level}**!';
const XP_MIN = 15;
const XP_MAX = 25;

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];

export function normaliseLevelingConfig(raw = {}) {
  return {
    cooldownSeconds: clampInt(raw.cooldownSeconds, 0, 3600, 60),
    announce: ANNOUNCE_MODES.includes(raw.announce) ? raw.announce : 'channel',
    announceChannel: /^\d{17,20}$/.test(raw.announceChannel ?? '') ? raw.announceChannel : '',
    announceMessage: String(raw.announceMessage ?? '').slice(0, 500) || DEFAULT_MESSAGE,
    noXpChannels: idList(raw.noXpChannels),
    noXpRoles: idList(raw.noXpRoles),
    stackRewards: raw.stackRewards !== false,
    publicLeaderboard: raw.publicLeaderboard !== false,
    rewards: (Array.isArray(raw.rewards) ? raw.rewards : [])
      .map((r) => ({ level: clampInt(r.level, 1, 1000, 0), roleId: String(r.roleId ?? '') }))
      .filter((r) => r.level >= 1 && /^\d{17,20}$/.test(r.roleId))
      .sort((a, b) => a.level - b.level)
      .slice(0, 50),
  };
}

// Fast-path cooldown gate so spam doesn't hit the DB. key -> last-award ts.
const cooldowns = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, ts] of cooldowns) if (ts < cutoff) cooldowns.delete(k);
}, 600_000).unref();

function fillMessage(template, member, level) {
  return String(template || DEFAULT_MESSAGE)
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{level}', String(level));
}

on('leveling', 'messageCreate', async (message, rawConfig, guildId) => {
  if (!message.member || message.author?.bot) return;
  const config = normaliseLevelingConfig(rawConfig);

  if (config.noXpChannels.includes(message.channelId)) return;
  if (config.noXpRoles.some((r) => message.member.roles.cache.has(r))) return;

  const key = `${guildId}:${message.author.id}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) ?? 0) < config.cooldownSeconds * 1000) return;
  cooldowns.set(key, now);

  const gain = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const { level, leveledUp } = addXp(guildId, message.author.id, gain, now);
  if (!leveledUp) return;

  const text = fillMessage(config.announceMessage, message.member, level);
  try {
    if (config.announce === 'reply') {
      await message.reply({ content: text, allowedMentions: { repliedUser: false, users: [message.author.id] } });
    } else if (config.announce === 'dm') {
      await message.author.send({ content: `${text} (in ${message.guild.name})` }).catch(() => {});
    } else if (config.announce === 'channel') {
      const target = config.announceChannel || message.channelId;
      await sendToChannel(guildId, target, { content: text, allowedMentions: { users: [message.author.id] } });
    }
  } catch {
    /* announcement is best-effort */
  }

  await applyRewards(message.member, level, config).catch(() => {});
});

async function applyRewards(member, level, config) {
  const earned = config.rewards.filter((r) => level >= r.level);
  if (earned.length === 0) return;

  const me = runtime.client?.guilds.cache.get(member.guild.id)?.members.me;
  const canManage = me?.permissions.has('ManageRoles');
  if (!canManage) return;

  const manageable = (roleId) => {
    const role = member.guild.roles.cache.get(roleId);
    return role && role.editable;
  };

  let toAdd;
  let toRemove = [];
  if (config.stackRewards) {
    toAdd = earned.map((r) => r.roleId);
  } else {
    const highest = earned[earned.length - 1].roleId; // rewards are sorted ascending
    toAdd = [highest];
    toRemove = earned.map((r) => r.roleId).filter((id) => id !== highest && member.roles.cache.has(id));
  }

  toAdd = toAdd.filter((id) => manageable(id) && !member.roles.cache.has(id));
  toRemove = toRemove.filter(manageable);

  if (toAdd.length) await member.roles.add(toAdd, 'Leveling reward');
  if (toRemove.length) await member.roles.remove(toRemove, 'Leveling reward (non-stacking)');
}
