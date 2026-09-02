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
export const XP_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3];
const DEFAULT_MESSAGE = 'GG {player}, you just advanced to level {level}!';
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
    xpRate: XP_RATES.includes(Number(raw.xpRate)) ? Number(raw.xpRate) : 1,
    announce: ANNOUNCE_MODES.includes(raw.announce) ? raw.announce : 'channel',
    announceChannel: /^\d{17,20}$/.test(raw.announceChannel ?? '') ? raw.announceChannel : '',
    announceMessage: String(raw.announceMessage ?? '').slice(0, 2000) || DEFAULT_MESSAGE,
    noXpChannels: idList(raw.noXpChannels),
    noXpChannelsMode: raw.noXpChannelsMode === 'deny' ? 'deny' : 'allow',
    noXpRoles: idList(raw.noXpRoles),
    noXpRolesMode: raw.noXpRolesMode === 'deny' ? 'deny' : 'allow',
    stackRewards: raw.stackRewards !== false,
    removeRewardsOnXpLoss: Boolean(raw.removeRewardsOnXpLoss),
    publicLeaderboard: raw.publicLeaderboard !== false,
    rewards: (Array.isArray(raw.rewards) ? raw.rewards : [])
      .map((r) => ({ level: Math.floor(Number(r.level)), roleId: String(r.roleId ?? '') }))
      .filter(
        (r) => Number.isInteger(r.level) && r.level >= 1 && r.level <= 1000 && /^\d{17,20}$/.test(r.roleId)
      )
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
    .replaceAll('{player}', `<@${member.id}>`)
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{level}', String(level));
}

on('leveling', 'messageCreate', async (message, rawConfig, guildId) => {
  if (!message.member || message.author?.bot) return;
  const config = normaliseLevelingConfig(rawConfig);

  const inChanList = config.noXpChannels.includes(message.channelId);
  if (config.noXpChannelsMode === 'deny' ? !inChanList : inChanList) return;
  const inRoleList = config.noXpRoles.some((r) => message.member.roles.cache.has(r));
  if (config.noXpRolesMode === 'deny' ? !inRoleList : inRoleList) return;

  const key = `${guildId}:${message.author.id}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) ?? 0) < config.cooldownSeconds * 1000) return;
  cooldowns.set(key, now);

  const base = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const gain = Math.max(1, Math.round(base * config.xpRate));
  const { level, leveledUp } = addXp(guildId, message.author.id, gain, now);
  if (!leveledUp) return;

  const text = fillMessage(config.announceMessage, message.member, level);
  try {
    if (config.announce === 'reply') {
      await message.reply({
        content: text,
        allowedMentions: { repliedUser: false, users: [message.author.id] },
      });
    } else if (config.announce === 'dm') {
      await message.author.send({ content: `${text} (in ${message.guild.name})` }).catch(() => {});
    } else if (config.announce === 'channel') {
      const target = config.announceChannel || message.channelId;
      await sendToChannel(guildId, target, {
        content: text,
        allowedMentions: { users: [message.author.id] },
      });
    }
  } catch {
    /* announcement is best-effort */
  }

  await syncRewards(message.member, level, config).catch(() => {});
});

/** Add roles the member now qualifies for and (optionally) strip ones above their level. */
export async function syncRewards(member, level, config) {
  await applyRewards(member, level, config).catch(() => {});
  if (!config.removeRewardsOnXpLoss) return;
  const me = member.guild.members.me;
  if (!me?.permissions.has('ManageRoles')) return;
  const strip = (config.rewards || [])
    .filter((r) => r.level > level && member.roles.cache.has(r.roleId))
    .map((r) => r.roleId)
    .filter((id) => member.guild.roles.cache.get(id)?.editable);
  if (strip.length) await member.roles.remove(strip, 'Leveling reward removed (XP dropped)').catch(() => {});
}

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
