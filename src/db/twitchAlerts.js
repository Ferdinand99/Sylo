// Dedup state for the Twitch alerts module — one row per (guild, login) while
// we consider that streamer live, storing the stream id we announced.
import { db } from './index.js';

const getStmt = db.prepare('SELECT stream_id FROM twitch_live WHERE guild_id = ? AND login = ?');
const upsertStmt = db.prepare(`
  INSERT INTO twitch_live (guild_id, login, stream_id, posted_at)
  VALUES (@guildId, @login, @streamId, @now)
  ON CONFLICT (guild_id, login) DO UPDATE SET stream_id = excluded.stream_id, posted_at = excluded.posted_at
`);
const clearStmt = db.prepare('DELETE FROM twitch_live WHERE guild_id = ? AND login = ?');
const clearGuildStmt = db.prepare('DELETE FROM twitch_live WHERE guild_id = ?');

/** The stream id we last announced for this streamer, or null. */
export function announcedStreamId(guildId, login) {
  return getStmt.get(guildId, login)?.stream_id ?? null;
}
export function markLive(guildId, login, streamId) {
  upsertStmt.run({ guildId, login, streamId, now: Date.now() });
}
export function markOffline(guildId, login) {
  clearStmt.run(guildId, login);
}
export function clearGuildTwitch(guildId) {
  clearGuildStmt.run(guildId);
}
