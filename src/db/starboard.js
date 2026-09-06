// Tracks which source messages have been promoted to a starboard.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS starboard_posts (
    guild_id       TEXT NOT NULL,
    board_id       TEXT NOT NULL,
    source_msg_id  TEXT NOT NULL,
    source_chan_id TEXT NOT NULL,
    post_msg_id    TEXT,
    star_count     INTEGER NOT NULL DEFAULT 0,
    posted_at      BIGINT,
    PRIMARY KEY (guild_id, board_id, source_msg_id)
  );
  CREATE INDEX IF NOT EXISTS idx_starboard_post ON starboard_posts (post_msg_id);
  CREATE INDEX IF NOT EXISTS idx_starboard_guild ON starboard_posts (guild_id, board_id);
`);

const stmts = {
  get: prepare('SELECT * FROM starboard_posts WHERE guild_id = ? AND board_id = ? AND source_msg_id = ?'),
  byPost: prepare('SELECT * FROM starboard_posts WHERE post_msg_id = ?'),
  upsert: prepare(`
    INSERT INTO starboard_posts (guild_id, board_id, source_msg_id, source_chan_id, post_msg_id, star_count, posted_at)
    VALUES (@guildId, @boardId, @sourceMsgId, @sourceChanId, @postMsgId, @starCount, @postedAt)
    ON CONFLICT (guild_id, board_id, source_msg_id) DO UPDATE SET
      source_chan_id = excluded.source_chan_id,
      post_msg_id    = excluded.post_msg_id,
      star_count     = excluded.star_count,
      posted_at      = COALESCE(starboard_posts.posted_at, excluded.posted_at)
  `),
  setPost: prepare(
    'UPDATE starboard_posts SET post_msg_id = @postMsgId, posted_at = @postedAt WHERE guild_id = @guildId AND board_id = @boardId AND source_msg_id = @sourceMsgId'
  ),
  setCount: prepare(
    'UPDATE starboard_posts SET star_count = @starCount WHERE guild_id = @guildId AND board_id = @boardId AND source_msg_id = @sourceMsgId'
  ),
  del: prepare('DELETE FROM starboard_posts WHERE guild_id = ? AND board_id = ? AND source_msg_id = ?'),
  delBoard: prepare('DELETE FROM starboard_posts WHERE guild_id = ? AND board_id = ?'),
  delGuild: prepare('DELETE FROM starboard_posts WHERE guild_id = ?'),
};

export async function getStarboardEntry(guildId, boardId, sourceMsgId) {
  return (await stmts.get.get(guildId, boardId, sourceMsgId)) ?? null;
}
export async function getStarboardEntryByPost(postMsgId) {
  return (await stmts.byPost.get(postMsgId)) ?? null;
}
export async function upsertStarboardEntry(e) {
  await stmts.upsert.run({
    guildId: e.guildId,
    boardId: e.boardId,
    sourceMsgId: e.sourceMsgId,
    sourceChanId: e.sourceChanId,
    postMsgId: e.postMsgId ?? null,
    starCount: e.starCount ?? 0,
    postedAt: e.postedAt ?? null,
  });
}
export async function setStarboardPost(guildId, boardId, sourceMsgId, postMsgId, postedAt) {
  await stmts.setPost.run({
    guildId,
    boardId,
    sourceMsgId,
    postMsgId: postMsgId ?? null,
    postedAt: postedAt ?? null,
  });
}
export async function setStarboardCount(guildId, boardId, sourceMsgId, starCount) {
  await stmts.setCount.run({ guildId, boardId, sourceMsgId, starCount });
}
export async function deleteStarboardEntry(guildId, boardId, sourceMsgId) {
  await stmts.del.run(guildId, boardId, sourceMsgId);
}
export async function deleteBoardEntries(guildId, boardId) {
  await stmts.delBoard.run(guildId, boardId);
}
export async function clearGuildStarboard(guildId) {
  await stmts.delGuild.run(guildId);
}
