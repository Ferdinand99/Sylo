// Storage for dashboard-composed bot messages ("Embed messages").
import { prepare, registerPostgresBootstrap } from './driver.js';

// Column set reflects the CREATE TABLE migration PLUS a later
// `ALTER TABLE composed_messages ADD COLUMN name ...` migration — the
// bootstrap must account for every migration touching a table, not just its
// original CREATE TABLE (caught by a real Postgres insert error: "column
// name does not exist").
registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS composed_messages (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    spec       TEXT NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL,
    name       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_composed_guild ON composed_messages (guild_id, updated_at DESC);
`);

const listStmt = prepare(
  'SELECT id, name, channel_id, message_id, spec, updated_at FROM composed_messages WHERE guild_id = ? ORDER BY updated_at DESC LIMIT ?'
);
const getStmt = prepare('SELECT * FROM composed_messages WHERE id = ? AND guild_id = ?');
const getByMsgStmt = prepare('SELECT * FROM composed_messages WHERE guild_id = ? AND message_id = ?');
const insertStmt = prepare(
  `
  INSERT INTO composed_messages (guild_id, name, channel_id, message_id, spec, updated_at)
  VALUES (@guildId, @name, @channelId, @messageId, @spec, @now)
`,
  { returningId: true }
);
const updateStmt = prepare(`
  UPDATE composed_messages SET name = @name, channel_id = @channelId, message_id = @messageId, spec = @spec, updated_at = @now
  WHERE id = @id AND guild_id = @guildId
`);
const deleteStmt = prepare('DELETE FROM composed_messages WHERE id = ? AND guild_id = ?');

const parse = (row) => ({ ...row, spec: safe(row.spec) });

export async function listComposed(guildId, limit = 50) {
  return (await listStmt.all(guildId, limit)).map(parse);
}
export async function getComposed(guildId, id) {
  const row = await getStmt.get(id, guildId);
  return row ? parse(row) : null;
}
export async function getComposedByMessage(guildId, messageId) {
  const row = await getByMsgStmt.get(guildId, messageId);
  return row ? parse(row) : null;
}
export async function createComposed(guildId, { name, channelId, messageId, spec }) {
  const info = await insertStmt.run({
    guildId,
    name: String(name ?? '').slice(0, 100),
    channelId,
    messageId: messageId ?? null,
    spec: JSON.stringify(spec),
    now: Date.now(),
  });
  return getComposed(guildId, Number(info.lastInsertRowid));
}
export async function updateComposed(guildId, id, { name, channelId, messageId, spec }) {
  await updateStmt.run({
    guildId,
    id,
    name: String(name ?? '').slice(0, 100),
    channelId,
    messageId: messageId ?? null,
    spec: JSON.stringify(spec),
    now: Date.now(),
  });
  return getComposed(guildId, id);
}
export async function deleteComposed(guildId, id) {
  return (await deleteStmt.run(id, guildId)).changes > 0;
}

function safe(json) {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}
