// Warning records, used by the /warn command group.
import { db } from './index.js';

const insertStmt = db.prepare(`
  INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at)
  VALUES (@guildId, @userId, @moderatorId, @reason, @createdAt)
`);
const listStmt = db.prepare(`
  SELECT id, moderator_id, reason, created_at
  FROM warnings
  WHERE guild_id = ? AND user_id = ?
  ORDER BY created_at DESC
`);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?');
const guildListStmt = db.prepare(`
  SELECT id, user_id, moderator_id, reason, created_at
  FROM warnings
  WHERE guild_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const guildCountStmt = db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ?');
const getStmt = db.prepare('SELECT * FROM warnings WHERE id = ? AND guild_id = ?');
const deleteStmt = db.prepare('DELETE FROM warnings WHERE id = ? AND guild_id = ?');
const clearStmt = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?');

/**
 * @param {{ guildId: string, userId: string, moderatorId: string, reason: string }} w
 * @returns {{ id: number, count: number }} the new warning id and the user's total count
 */
export function addWarning({ guildId, userId, moderatorId, reason }) {
  const info = insertStmt.run({ guildId, userId, moderatorId, reason, createdAt: Date.now() });
  const { n } = countStmt.get(guildId, userId);
  return { id: Number(info.lastInsertRowid), count: n };
}

/** @returns {Array<{ id: number, moderator_id: string, reason: string, created_at: number }>} */
export function listWarnings(guildId, userId) {
  return listStmt.all(guildId, userId);
}

/**
 * All warnings in a guild, newest first, plus the total count.
 * @param {string} guildId
 * @param {number} [limit=200]
 * @returns {{ rows: Array<{ id: number, user_id: string, moderator_id: string, reason: string, created_at: number }>, total: number }}
 */
export function listGuildWarnings(guildId, limit = 200) {
  return {
    rows: guildListStmt.all(guildId, limit),
    total: guildCountStmt.get(guildId).n,
  };
}

export function getWarning(guildId, id) {
  return getStmt.get(id, guildId);
}

/** @returns {boolean} whether a row was removed */
export function removeWarning(guildId, id) {
  return deleteStmt.run(id, guildId).changes > 0;
}

/** @returns {number} how many warnings were removed */
export function clearWarnings(guildId, userId) {
  return clearStmt.run(guildId, userId).changes;
}
