// Dedup state for YouTube alerts: video ids already announced per (guild,
// channel), and current-live state (one row while a channel is live).
import { db } from './index.js';

const stmts = {
  seenAny: db.prepare('SELECT 1 FROM youtube_video_seen WHERE guild_id = ? AND yt_channel = ? LIMIT 1'),
  isSeen: db.prepare(
    'SELECT 1 FROM youtube_video_seen WHERE guild_id = ? AND yt_channel = ? AND video_id = ?'
  ),
  markSeen: db.prepare(
    'INSERT OR IGNORE INTO youtube_video_seen (guild_id, yt_channel, video_id, seen_at) VALUES (?, ?, ?, ?)'
  ),
  pruneSeen: db.prepare('DELETE FROM youtube_video_seen WHERE seen_at < ?'),
  getLive: db.prepare('SELECT video_id FROM youtube_live WHERE guild_id = ? AND yt_channel = ?'),
  setLive: db.prepare(`
    INSERT INTO youtube_live (guild_id, yt_channel, video_id, posted_at) VALUES (@g, @c, @v, @now)
    ON CONFLICT (guild_id, yt_channel) DO UPDATE SET video_id = excluded.video_id, posted_at = excluded.posted_at
  `),
  clearLive: db.prepare('DELETE FROM youtube_live WHERE guild_id = ? AND yt_channel = ?'),
  clearGuildSeen: db.prepare('DELETE FROM youtube_video_seen WHERE guild_id = ?'),
  clearGuildLive: db.prepare('DELETE FROM youtube_live WHERE guild_id = ?'),
};

const KEEP_MS = 45 * 24 * 60 * 60 * 1000;

export function hasSeenAny(guildId, ytChannel) {
  return stmts.seenAny.get(guildId, ytChannel) != null;
}
export function isVideoSeen(guildId, ytChannel, videoId) {
  return stmts.isSeen.get(guildId, ytChannel, videoId) != null;
}
export function markVideoSeen(guildId, ytChannel, videoId) {
  stmts.markSeen.run(guildId, ytChannel, videoId, Date.now());
}
export function pruneYoutube() {
  stmts.pruneSeen.run(Date.now() - KEEP_MS);
}
export function liveVideoId(guildId, ytChannel) {
  return stmts.getLive.get(guildId, ytChannel)?.video_id ?? null;
}
export function markLive(guildId, ytChannel, videoId) {
  stmts.setLive.run({ g: guildId, c: ytChannel, v: videoId, now: Date.now() });
}
export function markNotLive(guildId, ytChannel) {
  stmts.clearLive.run(guildId, ytChannel);
}
export function clearGuildYoutube(guildId) {
  stmts.clearGuildSeen.run(guildId);
  stmts.clearGuildLive.run(guildId);
}
