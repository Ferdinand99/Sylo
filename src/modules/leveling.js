// Leveling: members earn XP for chatting and for time in voice, level up on a
// MEE6-style curve, and can be granted roles at set levels.
//
// config shape (see normaliseLevelingConfig):
//   { cooldownSeconds, xpRate, announce: 'channel'|'reply'|'dm'|'off',
//     announceChannel, announceMessage, noXpChannels: [], noXpRoles: [],
//     stackRewards, removeRewardsOnXpLoss, publicLeaderboard,
//     voiceXpEnabled, voiceXpPerMin, voiceAfkExcluded,
//     multipliers: [ { type: 'role'|'channel', id, factor } ],
//     rewards: [ { level, roleId } ] }
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { addXp, prunePeriods } from '../db/leveling.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

export const ANNOUNCE_MODES = ['channel', 'reply', 'dm', 'off'];
export const XP_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3];
export const MULTIPLIER_TYPES = ['role', 'channel'];
const DEFAULT_MESSAGE = 'GG {player}, you just advanced to level {level}!';
const XP_MIN = 15;
const XP_MAX = 25;

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const clampFactor = (v) => {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) ? Math.max(0.1, Math.min(5, n)) : 1;
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
    voiceXpEnabled: Boolean(raw.voiceXpEnabled),
    voiceXpPerMin: clampInt(raw.voiceXpPerMin, 1, 60, 10),
    voiceAfkExcluded: raw.voiceAfkExcluded !== false,
    multipliers: (Array.isArray(raw.multipliers) ? raw.multipliers : [])
      .map((m) => ({
        type: m.type === 'channel' ? 'channel' : 'role',
        id: String(m.id ?? ''),
        factor: clampFactor(m.factor),
      }))
      .filter((m) => /^\d{17,20}$/.test(m.id))
      .slice(0, 25),
    rewards: (Array.isArray(raw.rewards) ? raw.rewards : [])
      .map((r) => ({ level: Math.floor(Number(r.level)), roleId: String(r.roleId ?? '') }))
      .filter(
        (r) => Number.isInteger(r.level) && r.level >= 1 && r.level <= 1000 && /^\d{17,20}$/.test(r.roleId)
      )
      .sort((a, b) => a.level - b.level)
      .slice(0, 50),
  };
}

/**
 * The XP multiplier that applies to a member in a channel: the highest matching
 * role factor times the channel's factor (each defaulting to 1×), capped at 10×.
 * @param {{ multipliers?: Array<{type:string,id:string,factor:number}> }} config
 * @param {{ roleIds?: string[], channelId?: string }} ctx
 */
export function resolveMultiplier(config, { roleIds = [], channelId } = {}) {
  const mults = Array.isArray(config.multipliers) ? config.multipliers : [];
  let roleFactor = 1;
  let channelFactor = 1;
  for (const m of mults) {
    if (m.type === 'role' && roleIds.includes(m.id)) roleFactor = Math.max(roleFactor, m.factor);
    else if (m.type === 'channel' && m.id === channelId) channelFactor = m.factor;
  }
  return Math.min(10, roleFactor * channelFactor);
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

/** Announce a level-up. `channel` is where it happened (null for voice). */
async function announceLevelUp(config, member, level, { message, channel } = {}) {
  const text = fillMessage(config.announceMessage, member, level);
  const guildId = member.guild.id;
  try {
    if (config.announce === 'reply' && message) {
      await message.reply({
        content: text,
        allowedMentions: { repliedUser: false, users: [member.id] },
      });
    } else if (config.announce === 'dm') {
      await member.user.send({ content: `${text} (in ${member.guild.name})` }).catch(() => {});
    } else if (config.announce === 'channel' || config.announce === 'reply') {
      const target = config.announceChannel || channel;
      if (target) {
        await sendToChannel(guildId, target, { content: text, allowedMentions: { users: [member.id] } });
      }
    }
  } catch {
    /* announcement is best-effort */
  }
}

// --- text XP -----------------------------------------------------------

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
  const mult = resolveMultiplier(config, {
    roleIds: [...message.member.roles.cache.keys()],
    channelId: message.channelId,
  });
  const gain = Math.max(1, Math.round(base * config.xpRate * mult));
  const { level, leveledUp } = addXp(guildId, message.author.id, gain, now);
  if (!leveledUp) return;

  await announceLevelUp(config, message.member, level, { message, channel: message.channelId });
  await syncRewards(message.member, level, config).catch(() => {});
});

// --- voice XP --------------------------------------------------------
// Open voice sessions per guild: guildId -> Map<userId, { at, channelId }>.
// Settled on leave/move and by a slow interval so a long call still levels a
// member up mid-session rather than only when they disconnect.
const voiceSessions = new Map();
const VOICE_SETTLE_MS = 3 * 60_000;

function sessionsFor(guildId) {
  let m = voiceSessions.get(guildId);
  if (!m) {
    m = new Map();
    voiceSessions.set(guildId, m);
  }
  return m;
}

/** Whether the member is "actively" in voice for XP purposes right now. */
function voiceEarns(config, guild, channelId, userId) {
  if (!config.voiceAfkExcluded) return true;
  if (channelId && channelId === guild.afkChannelId) return false;
  const vs = guild.voiceStates.cache.get(userId);
  if (vs?.deaf || vs?.selfDeaf) return false;
  const others = [...guild.voiceStates.cache.values()].filter(
    (s) => s.channelId === channelId && s.member?.user?.bot !== true
  ).length;
  return others >= 2;
}

/**
 * Award XP for the elapsed portion of an open voice session. When `keepOpen`,
 * advance the session clock and keep it; otherwise the caller drops it.
 */
async function settleVoiceSession(guildId, member, session, now, rawConfig, { keepOpen }) {
  const config = normaliseLevelingConfig(rawConfig);
  if (!config.voiceXpEnabled) {
    if (keepOpen) session.at = now;
    return;
  }
  const minutes = Math.floor((now - session.at) / 60_000);
  if (minutes < 1) return;
  if (keepOpen) session.at += minutes * 60_000; // carry the sub-minute remainder

  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild || !voiceEarns(config, guild, session.channelId, member.id)) return;

  const mult = resolveMultiplier(config, {
    roleIds: [...(member.roles?.cache?.keys?.() ?? [])],
    channelId: session.channelId,
  });
  const gain = Math.max(1, Math.round(minutes * config.voiceXpPerMin * config.xpRate * mult));
  const { level, leveledUp } = addXp(guildId, member.id, gain, now, { voice: true, minutes });
  if (!leveledUp) return;

  await announceLevelUp(config, member, level, { channel: config.announceChannel || null });
  await syncRewards(member, level, config).catch(() => {});
}

on('leveling', 'voiceStateUpdate', async ({ old: before, new: after }, rawConfig, guildId) => {
  const member = after.member ?? before.member;
  if (!member || member.user?.bot) return;
  const from = before.channelId;
  const to = after.channelId;
  if (from === to) return; // mute / deafen / stream toggle — not a move

  const sessions = sessionsFor(guildId);
  const open = sessions.get(member.id);
  if (open) {
    await settleVoiceSession(guildId, member, open, Date.now(), rawConfig, { keepOpen: false });
    sessions.delete(member.id);
  }
  if (to) sessions.set(member.id, { at: Date.now(), channelId: to });
  if (!sessions.size) voiceSessions.delete(guildId);
});

/**
 * Open a session for anyone already sitting in voice with no session yet.
 * `voiceStateUpdate` only fires on a change, so members who were connected when
 * the process (re)started would otherwise never accrue voice XP.
 */
function discoverVoiceSessions(now) {
  if (!runtime.client?.isReady()) return;
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'leveling')) continue;
    if (!normaliseLevelingConfig(getGuildModule(guild.id, 'leveling').config).voiceXpEnabled) continue;
    const sessions = sessionsFor(guild.id);
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || vs.member?.user?.bot) continue;
      if (!sessions.has(vs.id)) sessions.set(vs.id, { at: now, channelId: vs.channelId });
    }
  }
}

async function settleAllVoice(now = Date.now()) {
  discoverVoiceSessions(now);
  for (const [guildId, sessions] of voiceSessions) {
    if (!sessions.size) {
      voiceSessions.delete(guildId);
      continue;
    }
    if (!isModuleEnabled(guildId, 'leveling')) continue;
    const rawConfig = getGuildModule(guildId, 'leveling').config;
    const guild = runtime.client?.guilds.cache.get(guildId);
    for (const [userId, session] of sessions) {
      const member = guild?.members.cache.get(userId);
      if (!member) continue;
      try {
        await settleVoiceSession(guildId, member, session, now, rawConfig, { keepOpen: true });
      } catch (err) {
        log.error('module:leveling', 'voice settle failed:', err.message);
      }
    }
  }
  prunePeriods();
}

const voiceTimer = setInterval(() => {
  settleAllVoice().catch((err) => log.error('module:leveling', 'voice tick failed:', err.message));
}, VOICE_SETTLE_MS);
voiceTimer.unref();
// Seed sessions for members already in voice shortly after boot, so a restart
// doesn't cost everyone connected a full settle interval of accrual.
setTimeout(() => discoverVoiceSessions(Date.now()), 25_000).unref();

export const _internals = { voiceSessions, settleAllVoice, settleVoiceSession, discoverVoiceSessions };

// --- role rewards ----------------------------------------------------

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
