// Dedup store for the free-games notifier — one posted_keys row per
// (guild, offer) already announced.
import { seen, markSeen, pruneScopeOlderThan } from './postedKeys.js';

const SCOPE = 'free-games';
const KEEP_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export function wasPosted(guildId, gameKey) {
  return seen(guildId, SCOPE, gameKey);
}

export function markPosted(guildId, gameKey) {
  markSeen(guildId, SCOPE, gameKey);
}

export function pruneFreeGames() {
  pruneScopeOlderThan(SCOPE, KEEP_MS);
}
