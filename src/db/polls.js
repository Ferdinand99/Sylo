// Active polls. A row exists only while a poll is open; ending it deletes the row.
import { db } from './index.js';

const stmts = {
  create: db.prepare(`
    INSERT INTO polls (message_id, guild_id, channel_id, question, options, multiple, max_votes, ends_at, created_by, created_at)
    VALUES (@messageId, @guildId, @channelId, @question, @options, @multiple, @maxVotes, @endsAt, @createdBy, @createdAt)
  `),
  get: db.prepare('SELECT * FROM polls WHERE message_id = ?'),
  inChannel: db.prepare('SELECT * FROM polls WHERE guild_id = ? AND channel_id = ? ORDER BY created_at DESC'),
  due: db.prepare('SELECT * FROM polls WHERE ends_at IS NOT NULL AND ends_at <= ?'),
  countGuild: db.prepare('SELECT COUNT(*) AS n FROM polls WHERE guild_id = ?'),
  del: db.prepare('DELETE FROM polls WHERE message_id = ?'),
  delGuild: db.prepare('DELETE FROM polls WHERE guild_id = ?'),
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

export function createPoll(p) {
  stmts.create.run({
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
export function getPoll(messageId) {
  return hydrate(stmts.get.get(messageId));
}
export function pollsInChannel(guildId, channelId) {
  return stmts.inChannel.all(guildId, channelId).map(hydrate);
}
export function latestPollInChannel(guildId, channelId) {
  return hydrate(stmts.inChannel.all(guildId, channelId)[0]);
}
export function duePolls(now) {
  return stmts.due.all(now).map(hydrate);
}
export function guildPollCount(guildId) {
  return stmts.countGuild.get(guildId)?.n ?? 0;
}
export function deletePoll(messageId) {
  stmts.del.run(messageId);
}
export function clearGuildPolls(guildId) {
  stmts.delGuild.run(guildId);
}
