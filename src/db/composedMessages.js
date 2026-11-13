// Storage for dashboard-composed bot messages ("Embed messages").
import { prepare, registerPostgresBootstrap } from './driver.js';
import { LIMITS, checkLimit } from '../lib/limits.js';

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
// A draft save never writes message_id, and moves a draft to another channel only while nothing is
// posted: a posted message stays in its channel until it is published again, and a save that read
// the row before a publish must not undo what the publish stored.
const draftStmt = prepare(`
  UPDATE composed_messages SET name = @name,
    channel_id = CASE WHEN message_id IS NULL THEN @channelId ELSE channel_id END,
    spec = @spec, updated_at = @now
  WHERE id = @id AND guild_id = @guildId
`);
// A publish stores its post only if the message is still posted as it was when the publish began.
const claimStmt = (expectedSql) =>
  prepare(`
  UPDATE composed_messages SET name = @name, channel_id = @channelId, message_id = @messageId, spec = @spec, updated_at = @now
  WHERE id = @id AND guild_id = @guildId AND ${expectedSql}
`);
const claimUnpostedStmt = claimStmt('message_id IS NULL');
const claimPostedStmt = claimStmt('message_id = @expected');
const clearStmt = prepare(
  'UPDATE composed_messages SET message_id = NULL, updated_at = ? WHERE id = ? AND guild_id = ? AND message_id = ?'
);
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
const countForGuildStmt = prepare('SELECT COUNT(*) AS n FROM composed_messages WHERE guild_id = ?');

let specGuard = null;

/** Like setModuleConfigGuard (db/modules.js), for a saved message's spec. */
export function setComposedSpecGuard(fn) {
  specGuard = fn;
}

export async function createComposed(guildId, { name, channelId, messageId, spec }) {
  if (specGuard) await specGuard({ guildId, prev: {}, next: spec });
  checkLimit((await countForGuildStmt.get(guildId)).n, LIMITS.composedMessages, 'saved messages');
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
  if (specGuard) await specGuard({ guildId, prev: (await getComposed(guildId, id))?.spec ?? {}, next: spec });
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
/** Save name, text and channel without touching message_id (see draftStmt). */
export async function saveComposedDraft(guildId, id, { name, channelId, spec }) {
  if (specGuard) await specGuard({ guildId, prev: (await getComposed(guildId, id))?.spec ?? {}, next: spec });
  await draftStmt.run({
    guildId,
    id,
    name: String(name ?? '').slice(0, 100),
    channelId,
    spec: JSON.stringify(spec),
    now: Date.now(),
  });
  return getComposed(guildId, id);
}

/**
 * Store the post of a publish: channel and message id together, but only while the row still has
 * `expectedMessageId` (null: not posted). False when someone else published in between; nothing is
 * written then, and the caller removes its own post.
 */
export async function claimComposedPost(
  guildId,
  id,
  { name, channelId, messageId, spec, expectedMessageId }
) {
  const params = {
    guildId,
    id,
    name: String(name ?? '').slice(0, 100),
    channelId,
    messageId,
    spec: JSON.stringify(spec),
    now: Date.now(),
  };
  const stmt = expectedMessageId == null ? claimUnpostedStmt : claimPostedStmt;
  if (expectedMessageId != null) params.expected = expectedMessageId;
  return (await stmt.run(params)).changes === 1;
}

/**
 * Mark a message as not posted, but only while it still has `expectedMessageId` (the post an unpublish
 * is about to delete). False when a publish stored another post in between; nothing is written then.
 */
export async function clearComposedPost(guildId, id, expectedMessageId) {
  return (await clearStmt.run(Date.now(), id, guildId, expectedMessageId)).changes === 1;
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
