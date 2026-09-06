// Dedup store for the free-games notifier — one posted_keys row per
// (guild, offer) already announced.
import { seen, markSeen, pruneScopeOlderThan } from './postedKeys.js';

const SCOPE = 'free-games';
const KEEP_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export async function wasPosted(guildId, gameKey) {
  return seen(guildId, SCOPE, gameKey);
}

export async function markPosted(guildId, gameKey) {
  await markSeen(guildId, SCOPE, gameKey);
}

export async function pruneFreeGames() {
  await pruneScopeOlderThan(SCOPE, KEEP_MS);
}
