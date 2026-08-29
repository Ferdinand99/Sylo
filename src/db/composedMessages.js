// Storage for dashboard-composed bot messages (Message Creator).
import { db } from './index.js';

const listStmt = db.prepare(
  'SELECT id, channel_id, message_id, spec, updated_at FROM composed_messages WHERE guild_id = ? ORDER BY updated_at DESC LIMIT ?'
);
const getStmt = db.prepare('SELECT * FROM composed_messages WHERE id = ? AND guild_id = ?');
const getByMsgStmt = db.prepare('SELECT * FROM composed_messages WHERE guild_id = ? AND message_id = ?');
const insertStmt = db.prepare(`
  INSERT INTO composed_messages (guild_id, channel_id, message_id, spec, updated_at)
  VALUES (@guildId, @channelId, @messageId, @spec, @now)
`);
const updateStmt = db.prepare(`
  UPDATE composed_messages SET channel_id = @channelId, message_id = @messageId, spec = @spec, updated_at = @now
  WHERE id = @id AND guild_id = @guildId
`);
const deleteStmt = db.prepare('DELETE FROM composed_messages WHERE id = ? AND guild_id = ?');

const parse = (row) => ({ ...row, spec: safe(row.spec) });

export function listComposed(guildId, limit = 50) {
  return listStmt.all(guildId, limit).map(parse);
}
export function getComposed(guildId, id) {
  const row = getStmt.get(id, guildId);
  return row ? parse(row) : null;
}
export function getComposedByMessage(guildId, messageId) {
  const row = getByMsgStmt.get(guildId, messageId);
  return row ? parse(row) : null;
}
export function createComposed(guildId, { channelId, messageId, spec }) {
  const info = insertStmt.run({ guildId, channelId, messageId: messageId ?? null, spec: JSON.stringify(spec), now: Date.now() });
  return getComposed(guildId, Number(info.lastInsertRowid));
}
export function updateComposed(guildId, id, { channelId, messageId, spec }) {
  updateStmt.run({ guildId, id, channelId, messageId: messageId ?? null, spec: JSON.stringify(spec), now: Date.now() });
  return getComposed(guildId, id);
}
export function deleteComposed(guildId, id) {
  return deleteStmt.run(id, guildId).changes > 0;
}

function safe(json) {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}
