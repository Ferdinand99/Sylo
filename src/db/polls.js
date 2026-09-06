// Active polls. A row exists only while a poll is open; ending it deletes the row.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS polls (
    message_id  TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,
    multiple    INTEGER NOT NULL DEFAULT 0,
    max_votes   INTEGER NOT NULL DEFAULT 0,
    ends_at     BIGINT,
    created_by  TEXT NOT NULL,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_polls_guild ON polls (guild_id);
  CREATE INDEX IF NOT EXISTS idx_polls_ends ON polls (ends_at);
`);

const stmts = {
  create: prepare(`
    INSERT INTO polls (message_id, guild_id, channel_id, question, options, multiple, max_votes, ends_at, created_by, created_at)
    VALUES (@messageId, @guildId, @channelId, @question, @options, @multiple, @maxVotes, @endsAt, @createdBy, @createdAt)
  `),
  get: prepare('SELECT * FROM polls WHERE message_id = ?'),
  inChannel: prepare('SELECT * FROM polls WHERE guild_id = ? AND channel_id = ? ORDER BY created_at DESC'),
  due: prepare('SELECT * FROM polls WHERE ends_at IS NOT NULL AND ends_at <= ?'),
  countGuild: prepare('SELECT COUNT(*) AS n FROM polls WHERE guild_id = ?'),
  del: prepare('DELETE FROM polls WHERE message_id = ?'),
  delGuild: prepare('DELETE FROM polls WHERE guild_id = ?'),
};

const hydrate = (row) => {
  if (!row) return null;
  let options;
  try {
    options = JSON.parse(row.options);
  } catch {
    options = [];
  }
  return { ...row, options: Array.isArray(options) ? options : [] };
};

export async function createPoll(p) {
  await stmts.create.run({
    messageId: p.messageId,
    guildId: p.guildId,
    channelId: p.channelId,
    question: p.question,
    options: JSON.stringify(p.options),
    multiple: p.multiple ? 1 : 0,
    maxVotes: Math.max(0, Math.trunc(p.maxVotes || 0)),
    endsAt: p.endsAt ?? null,
    createdBy: p.createdBy,
    createdAt: p.createdAt ?? Date.now(),
  });
}
export async function getPoll(messageId) {
  return hydrate(await stmts.get.get(messageId));
}
export async function pollsInChannel(guildId, channelId) {
  return (await stmts.inChannel.all(guildId, channelId)).map(hydrate);
}
export async function latestPollInChannel(guildId, channelId) {
  return hydrate((await stmts.inChannel.all(guildId, channelId))[0]);
}
export async function duePolls(now) {
  return (await stmts.due.all(now)).map(hydrate);
}
export async function guildPollCount(guildId) {
  // COUNT(*) comes back as a JS number from better-sqlite3 but as a string
  // from postgres.js (bigint safety) — coerce so callers see the same type
  // regardless of driver.
  return Number((await stmts.countGuild.get(guildId))?.n ?? 0);
}
export async function deletePoll(messageId) {
  await stmts.del.run(messageId);
}
export async function clearGuildPolls(guildId) {
  await stmts.delGuild.run(guildId);
}
