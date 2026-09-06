// Per-guild AFK state.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS afk (
    guild_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    reason    TEXT NOT NULL DEFAULT 'AFK',
    since     BIGINT NOT NULL,
    old_nick  TEXT,
    PRIMARY KEY (guild_id, user_id)
  );
`);

const getStmt = prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?');
const setStmt = prepare(`
  INSERT INTO afk (guild_id, user_id, reason, since, old_nick)
  VALUES (@guildId, @userId, @reason, @since, @oldNick)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    reason = excluded.reason, since = excluded.since, old_nick = excluded.old_nick
`);
const clearStmt = prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?');
const clearGuildStmt = prepare('DELETE FROM afk WHERE guild_id = ?');

export async function getAfk(guildId, userId) {
  return (await getStmt.get(guildId, userId)) ?? null;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {{ reason: string, oldNick: string | null }} data
 */
export async function setAfk(guildId, userId, { reason, oldNick }) {
  await setStmt.run({
    guildId,
    userId,
    reason: String(reason || 'AFK').slice(0, 300),
    since: Date.now(),
    oldNick: oldNick ?? null,
  });
}

export async function clearAfk(guildId, userId) {
  await clearStmt.run(guildId, userId);
}

export async function clearGuildAfk(guildId) {
  await clearGuildStmt.run(guildId);
}
