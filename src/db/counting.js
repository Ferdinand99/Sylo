// Per-guild state for the Counting mini-game. Settings (which channel, rules)
// live in the module config; this table is the fast-changing runtime state.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS counting (
    guild_id        TEXT PRIMARY KEY,
    current         INTEGER NOT NULL DEFAULT 0,
    record          INTEGER NOT NULL DEFAULT 0,
    last_user_id    TEXT,
    last_message_id TEXT,
    updated_at      BIGINT NOT NULL
  );
`);

const selectStmt = prepare('SELECT * FROM counting WHERE guild_id = ?');
const upsertStmt = prepare(`
  INSERT INTO counting (guild_id, current, record, last_user_id, last_message_id, updated_at)
  VALUES (@guildId, @current, @record, @lastUserId, @lastMessageId, @updatedAt)
  ON CONFLICT (guild_id) DO UPDATE SET
    current         = excluded.current,
    record          = excluded.record,
    last_user_id    = excluded.last_user_id,
    last_message_id = excluded.last_message_id,
    updated_at      = excluded.updated_at
`);

const EMPTY = { current: 0, record: 0, last_user_id: null, last_message_id: null };

/** Current counting state for a guild (zeroed defaults if never played). */
export async function getCounting(guildId) {
  return (await selectStmt.get(guildId)) ?? { guild_id: guildId, ...EMPTY };
}

/**
 * Record a successful count.
 * @param {string} guildId
 * @param {{ current: number, userId: string, messageId: string }} next
 */
export async function advanceCount(guildId, { current, userId, messageId }) {
  const prev = await getCounting(guildId);
  await upsertStmt.run({
    guildId,
    current,
    record: Math.max(prev.record, current),
    lastUserId: userId,
    lastMessageId: messageId,
    updatedAt: Date.now(),
  });
}

/** Reset the running count to 0 (keeps the record). */
export async function resetCount(guildId) {
  const prev = await getCounting(guildId);
  await upsertStmt.run({
    guildId,
    current: 0,
    record: prev.record,
    lastUserId: null,
    lastMessageId: null,
    updatedAt: Date.now(),
  });
}

/**
 * Force the count to an exact value from the dashboard. Clears the last-counter
 * lock so anyone may post the next number.
 * @param {string} guildId
 * @param {number} value
 */
export async function setCount(guildId, value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const prev = await getCounting(guildId);
  await upsertStmt.run({
    guildId,
    current: n,
    record: Math.max(prev.record, n),
    lastUserId: null,
    lastMessageId: null,
    updatedAt: Date.now(),
  });
  return n;
}
