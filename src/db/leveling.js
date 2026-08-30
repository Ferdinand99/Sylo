// Per-member XP / level state for the leveling module.
import { db } from './index.js';
import { levelFromXp } from '../modules/lib/levels.js';

const getStmt = db.prepare('SELECT * FROM leveling WHERE guild_id = ? AND user_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO leveling (guild_id, user_id, xp, level, messages, last_msg_at)
  VALUES (@guildId, @userId, @xp, @level, @messages, @lastMsgAt)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = excluded.xp, level = excluded.level,
    messages = excluded.messages, last_msg_at = excluded.last_msg_at
`);
const topStmt = db.prepare(
  'SELECT * FROM leveling WHERE guild_id = ? ORDER BY xp DESC LIMIT ? OFFSET ?'
);
const rankStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ? AND xp > ?'
);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ?');
const deleteGuildStmt = db.prepare('DELETE FROM leveling WHERE guild_id = ?');

const EMPTY = { xp: 0, level: 0, messages: 0, last_msg_at: 0 };

export function getMember(guildId, userId) {
  return getStmt.get(guildId, userId) ?? { guild_id: guildId, user_id: userId, ...EMPTY };
}

/**
 * Add XP for a message. Returns the new state plus whether the member levelled up.
 * @returns {{ xp: number, level: number, leveledUp: boolean, previousLevel: number }}
 */
export function addXp(guildId, userId, amount, now = Date.now()) {
  const prev = getMember(guildId, userId);
  const xp = prev.xp + Math.max(0, Math.floor(amount));
  const level = levelFromXp(xp);
  upsertStmt.run({
    guildId,
    userId,
    xp,
    level,
    messages: prev.messages + 1,
    lastMsgAt: now,
  });
  return { xp, level, leveledUp: level > prev.level, previousLevel: prev.level };
}

/** Force a member's XP to an exact value (dashboard correction). */
export function setXp(guildId, userId, xpValue) {
  const xp = Math.max(0, Math.floor(Number(xpValue) || 0));
  const prev = getMember(guildId, userId);
  upsertStmt.run({
    guildId,
    userId,
    xp,
    level: levelFromXp(xp),
    messages: prev.messages,
    lastMsgAt: prev.last_msg_at,
  });
  return xp;
}

export function topMembers(guildId, limit = 15, offset = 0) {
  return topStmt.all(guildId, limit, offset);
}

/** 1-based rank of a member within the guild by XP. */
export function memberRank(guildId, userId) {
  const me = getMember(guildId, userId);
  return rankStmt.get(guildId, me.xp).n + 1;
}

export function memberCount(guildId) {
  return countStmt.get(guildId).n;
}

export function resetGuildLeveling(guildId) {
  deleteGuildStmt.run(guildId);
}
