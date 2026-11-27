// When the bot joined each server, as far as this process saw it. A signed-in person's list of
// servers they run comes from sign-in (src/db/accounts.js) and follows the bot's rights events
// (src/bot/lib/adminSnapshot.js), but a server the bot joins afterwards is on nobody's list, so the
// dashboard would not show it until they sign in again. The dashboard compares these times with when
// each person's list was last looked at (src/web/lib/guildListRefresh.js) and re-checks only then.

/** A join older than this when its event arrives is startup catch-up, not a new server. */
const RECENT_MS = 5 * 60 * 1000;
/** How long a join is remembered; the dashboard looks at a list on the person's next request. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, number>} guild key -> when the bot joined */
const joinedAt = new Map();
/** @type {Record<string, number>} platform -> when the bot last joined a server there */
const lastJoin = {};

/**
 * The bot joined a server (guildCreate). Startup replays every existing server through the same event;
 * `ready` is false then, and a join the platform dates long ago is ignored too.
 * @param {'discord'|'fluxer'} platform
 * @param {string} key  the guild key
 * @param {{ joinedTimestamp?: number } | null} guild
 * @param {{ ready?: boolean, now?: number }} [opts]
 */
export function noteGuildJoin(platform, key, guild, { ready = true, now = Date.now() } = {}) {
  if (!key || !ready) return;
  const stamp = Number(guild?.joinedTimestamp);
  if (Number.isFinite(stamp) && stamp > 0 && now - stamp > RECENT_MS) return;
  for (const [k, at] of joinedAt) if (now - at > KEEP_MS) joinedAt.delete(k);
  joinedAt.set(key, now);
  lastJoin[platform] = now;
}

/** When the bot last joined a server on this platform (0: not since this process started). */
export const lastGuildJoin = (platform) => lastJoin[platform] ?? 0;

/** When the bot joined this server: seen by this process, else the platform's own date, else 0. */
export function guildJoinedAt(key, guild) {
  const seen = joinedAt.get(key);
  if (seen) return seen;
  const stamp = Number(guild?.joinedTimestamp);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
}

/** For tests: forget every join. */
export function resetGuildJoins() {
  joinedAt.clear();
  for (const p of Object.keys(lastJoin)) delete lastJoin[p];
}
