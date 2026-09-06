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

export async function hasSeenAny(guildId, ytChannel) {
  // YouTube channel ids are [A-Za-z0-9_-], so the ':' separator makes an
  // index-usable literal prefix.
  return anySeenMatching(guildId, VIDEO, `${ytChannel}:*`);
}
export async function isVideoSeen(guildId, ytChannel, videoId) {
  return seen(guildId, VIDEO, videoKey(ytChannel, videoId));
}
export async function markVideoSeen(guildId, ytChannel, videoId) {
  await markSeen(guildId, VIDEO, videoKey(ytChannel, videoId));
}
export async function pruneYoutube() {
  await pruneScopeOlderThan(VIDEO, KEEP_MS);
}
export async function liveVideoId(guildId, ytChannel) {
  const v = await seenValue(guildId, LIVE, ytChannel);
  return v == null ? null : decodeLiveValue(v).ref;
}
/** The announced live video id + the message we posted, or null. */
export async function livePost(guildId, ytChannel) {
  const row = await seenRow(guildId, LIVE, ytChannel);
  if (!row) return null;
  const { ref, channelId, messageId } = decodeLiveValue(row.value);
  return { videoId: ref, channelId, messageId, postedAt: row.posted_at };
}
/** @param {{ channelId: string, messageId: string } | null} [post] */
export async function markLive(guildId, ytChannel, videoId, post = null) {
  await markSeen(guildId, LIVE, ytChannel, encodeLiveValue(videoId, post?.channelId, post?.messageId), {
    upsert: true,
  });
}
export async function markNotLive(guildId, ytChannel) {
  await forget(guildId, LIVE, ytChannel);
}
