// Dedup state for the Twitch alerts module — one posted_keys row per
// (guild, login) while we consider that streamer live. `value` packs the
// announced stream id plus the Discord message we posted (see src/lib/liveValue),
// so the module can clean that message up once the stream ends.
import { seenValue, seenRow, markSeen, forget } from './postedKeys.js';
import { encodeLiveValue, decodeLiveValue } from '../lib/liveValue.js';

const SCOPE = 'twitch';

/** The stream id we last announced for this streamer, or null. */
export function announcedStreamId(guildId, login) {
  const v = seenValue(guildId, SCOPE, login);
  return v == null ? null : decodeLiveValue(v).ref;
}

/** The announced stream id + the message we posted, or null if not tracked. */
export function announcedPost(guildId, login) {
  const row = seenRow(guildId, SCOPE, login);
  if (!row) return null;
  const { ref, channelId, messageId } = decodeLiveValue(row.value);
  return { streamId: ref, channelId, messageId, postedAt: row.posted_at };
}

/** @param {{ channelId: string, messageId: string } | null} [post] */
export function markLive(guildId, login, streamId, post = null) {
  markSeen(guildId, SCOPE, login, encodeLiveValue(streamId, post?.channelId, post?.messageId), {
    upsert: true,
  });
}

export function markOffline(guildId, login) {
  forget(guildId, SCOPE, login);
}
