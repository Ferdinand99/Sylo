// Per-guild AFK state.
import { db } from './index.js';

const getStmt = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?');
const setStmt = db.prepare(`
  INSERT INTO afk (guild_id, user_id, reason, since, old_nick)
  VALUES (@guildId, @userId, @reason, @since, @oldNick)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    reason = excluded.reason, since = excluded.since, old_nick = excluded.old_nick
`);
const clearStmt = db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?');
const clearGuildStmt = db.prepare('DELETE FROM afk WHERE guild_id = ?');

export function getAfk(guildId, userId) {
  return getStmt.get(guildId, userId) ?? null;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {{ reason: string, oldNick: string | null }} data
 */
export function setAfk(guildId, userId, { reason, oldNick }) {
  setStmt.run({
    guildId,
    userId,
    reason: String(reason || 'AFK').slice(0, 300),
    since: Date.now(),
    oldNick: oldNick ?? null,
  });
}

export function clearAfk(guildId, userId) {
  clearStmt.run(guildId, userId);
}

export function clearGuildAfk(guildId) {
  clearGuildStmt.run(guildId);
}
