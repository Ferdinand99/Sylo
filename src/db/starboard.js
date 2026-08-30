// Tracks which source messages have been promoted to a starboard.
import { db } from './index.js';

const stmts = {
  get: db.prepare(
    'SELECT * FROM starboard_posts WHERE guild_id = ? AND board_id = ? AND source_msg_id = ?'
  ),
  byPost: db.prepare('SELECT * FROM starboard_posts WHERE post_msg_id = ?'),
  upsert: db.prepare(`
    INSERT INTO starboard_posts (guild_id, board_id, source_msg_id, source_chan_id, post_msg_id, star_count, posted_at)
    VALUES (@guildId, @boardId, @sourceMsgId, @sourceChanId, @postMsgId, @starCount, @postedAt)
    ON CONFLICT (guild_id, board_id, source_msg_id) DO UPDATE SET
      source_chan_id = excluded.source_chan_id,
      post_msg_id    = excluded.post_msg_id,
      star_count     = excluded.star_count,
      posted_at      = COALESCE(starboard_posts.posted_at, excluded.posted_at)
  `),
  setPost: db.prepare(
    'UPDATE starboard_posts SET post_msg_id = @postMsgId, posted_at = @postedAt WHERE guild_id = @guildId AND board_id = @boardId AND source_msg_id = @sourceMsgId'
  ),
  setCount: db.prepare(
    'UPDATE starboard_posts SET star_count = @starCount WHERE guild_id = @guildId AND board_id = @boardId AND source_msg_id = @sourceMsgId'
  ),
  del: db.prepare(
    'DELETE FROM starboard_posts WHERE guild_id = ? AND board_id = ? AND source_msg_id = ?'
  ),
  delBoard: db.prepare('DELETE FROM starboard_posts WHERE guild_id = ? AND board_id = ?'),
  delGuild: db.prepare('DELETE FROM starboard_posts WHERE guild_id = ?'),
};

export function getStarboardEntry(guildId, boardId, sourceMsgId) {
  return stmts.get.get(guildId, boardId, sourceMsgId) ?? null;
}
export function getStarboardEntryByPost(postMsgId) {
  return stmts.byPost.get(postMsgId) ?? null;
}
export function upsertStarboardEntry(e) {
  stmts.upsert.run({
    guildId: e.guildId,
    boardId: e.boardId,
    sourceMsgId: e.sourceMsgId,
    sourceChanId: e.sourceChanId,
    postMsgId: e.postMsgId ?? null,
    starCount: e.starCount ?? 0,
    postedAt: e.postedAt ?? null,
  });
}
export function setStarboardPost(guildId, boardId, sourceMsgId, postMsgId, postedAt) {
  stmts.setPost.run({ guildId, boardId, sourceMsgId, postMsgId: postMsgId ?? null, postedAt: postedAt ?? null });
}
export function setStarboardCount(guildId, boardId, sourceMsgId, starCount) {
  stmts.setCount.run({ guildId, boardId, sourceMsgId, starCount });
}
export function deleteStarboardEntry(guildId, boardId, sourceMsgId) {
  stmts.del.run(guildId, boardId, sourceMsgId);
}
export function deleteBoardEntries(guildId, boardId) {
  stmts.delBoard.run(guildId, boardId);
}
export function clearGuildStarboard(guildId) {
  stmts.delGuild.run(guildId);
}
