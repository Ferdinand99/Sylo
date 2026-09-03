// Dedup state for YouTube alerts, over posted_keys:
//   scope 'yt-video'  key '<ytChannel>:<videoId>'  — every announced video
//   scope 'yt-live'   key '<ytChannel>'  value '<videoId>'  — one row while live
import {
  seen,
  seenValue,
  seenRow,
  anySeenMatching,
  markSeen,
  forget,
  pruneScopeOlderThan,
} from './postedKeys.js';
import { encodeLiveValue, decodeLiveValue } from '../lib/liveValue.js';

const VIDEO = 'yt-video';
const LIVE = 'yt-live';
const KEEP_MS = 45 * 24 * 60 * 60 * 1000;

const videoKey = (ytChannel, videoId) => `${ytChannel}:${videoId}`;

export function hasSeenAny(guildId, ytChannel) {
  // YouTube channel ids are [A-Za-z0-9_-], so the ':' separator makes an
  // index-usable literal prefix.
  return anySeenMatching(guildId, VIDEO, `${ytChannel}:*`);
}
export function isVideoSeen(guildId, ytChannel, videoId) {
  return seen(guildId, VIDEO, videoKey(ytChannel, videoId));
}
export function markVideoSeen(guildId, ytChannel, videoId) {
  markSeen(guildId, VIDEO, videoKey(ytChannel, videoId));
}
export function pruneYoutube() {
  pruneScopeOlderThan(VIDEO, KEEP_MS);
}
export function liveVideoId(guildId, ytChannel) {
  const v = seenValue(guildId, LIVE, ytChannel);
  return v == null ? null : decodeLiveValue(v).ref;
}
/** The announced live video id + the message we posted, or null. */
export function livePost(guildId, ytChannel) {
  const row = seenRow(guildId, LIVE, ytChannel);
  if (!row) return null;
  const { ref, channelId, messageId } = decodeLiveValue(row.value);
  return { videoId: ref, channelId, messageId, postedAt: row.posted_at };
}
/** @param {{ channelId: string, messageId: string } | null} [post] */
export function markLive(guildId, ytChannel, videoId, post = null) {
  markSeen(guildId, LIVE, ytChannel, encodeLiveValue(videoId, post?.channelId, post?.messageId), {
    upsert: true,
  });
}
export function markNotLive(guildId, ytChannel) {
  forget(guildId, LIVE, ytChannel);
}
