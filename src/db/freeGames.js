// Dedup store for the free-games notifier — one row per (guild, offer) already
// announced.
import { db } from './index.js';

const hasStmt = db.prepare('SELECT 1 FROM free_games_posted WHERE guild_id = ? AND game_key = ?');
const markStmt = db.prepare(
  'INSERT OR IGNORE INTO free_games_posted (guild_id, game_key, posted_at) VALUES (?, ?, ?)'
);
const pruneStmt = db.prepare('DELETE FROM free_games_posted WHERE posted_at < ?');
const clearGuildStmt = db.prepare('DELETE FROM free_games_posted WHERE guild_id = ?');

const KEEP_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export function wasPosted(guildId, gameKey) {
  return hasStmt.get(guildId, gameKey) != null;
}

export function markPosted(guildId, gameKey) {
  markStmt.run(guildId, gameKey, Date.now());
}

export function pruneFreeGames() {
  pruneStmt.run(Date.now() - KEEP_MS);
}

export function clearGuildFreeGames(guildId) {
  clearGuildStmt.run(guildId);
}
