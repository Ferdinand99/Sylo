// Dedup state for YouTube alerts, over posted_keys:
//   scope 'yt-video'  key '<ytChannel>:<videoId>'  — every announced video
//   scope 'yt-live'   key '<ytChannel>'  value '<videoId>'  — one row while live
import { seen, seenValue, anySeenMatching, markSeen, forget, pruneScopeOlderThan } from './postedKeys.js';

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
  return seenValue(guildId, LIVE, ytChannel);
}
export function markLive(guildId, ytChannel, videoId) {
  markSeen(guildId, LIVE, ytChannel, videoId, { upsert: true });
}
export function markNotLive(guildId, ytChannel) {
  forget(guildId, LIVE, ytChannel);
}
