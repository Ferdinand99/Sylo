// Dedup state for the Twitch alerts module — one posted_keys row per
// (guild, login) while we consider that streamer live, its `value` holding the
// stream id we announced.
import { seenValue, markSeen, forget } from './postedKeys.js';

const SCOPE = 'twitch';

/** The stream id we last announced for this streamer, or null. */
export function announcedStreamId(guildId, login) {
  return seenValue(guildId, SCOPE, login);
}
export function markLive(guildId, login, streamId) {
  markSeen(guildId, SCOPE, login, streamId, { upsert: true });
}
export function markOffline(guildId, login) {
  forget(guildId, SCOPE, login);
}
