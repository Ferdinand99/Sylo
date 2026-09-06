// TTL-based caching for game stats lookups, backed by the stats_cache table.
// Caching keeps us well under the public API's rate limits and also powers the
// dashboard's "recently queried stats" list.
import { prepare, registerPostgresBootstrap } from './driver.js';
import { config } from '../config.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS stats_cache (
    cache_key  TEXT PRIMARY KEY,
    game       TEXT NOT NULL,
    title      TEXT NOT NULL,
    username   TEXT NOT NULL,
    platform   TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stats_cache_created_at ON stats_cache (created_at DESC);
`);

const selectStmt = prepare('SELECT payload, created_at FROM stats_cache WHERE cache_key = ?');
const deleteStmt = prepare('DELETE FROM stats_cache WHERE cache_key = ?');
const upsertStmt = prepare(`
  INSERT INTO stats_cache (cache_key, game, title, username, platform, payload, created_at)
  VALUES (@cacheKey, @game, @title, @username, @platform, @payload, @createdAt)
  ON CONFLICT (cache_key) DO UPDATE SET
    game       = excluded.game,
    title      = excluded.title,
    username   = excluded.username,
    platform   = excluded.platform,
    payload    = excluded.payload,
    created_at = excluded.created_at
`);
const recentStmt = prepare(`
  SELECT game, title, username, platform, created_at
  FROM stats_cache
  ORDER BY created_at DESC
  LIMIT ?
`);
const listStmt = prepare(`
  SELECT game, title, username, platform, payload, created_at
  FROM stats_cache
  ORDER BY created_at DESC
  LIMIT ?
`);

/**
 * Build the cache key for a stats lookup. Case-insensitive on the username.
 * @param {string} title    Game title id, e.g. "bf4".
 * @param {string} platform Platform id, e.g. "pc".
 * @param {string} username Player name as entered.
 * @returns {string}
 */
export function cacheKey(title, platform, username) {
  return `${title}:${platform}:${username.toLowerCase()}`;
}

/**
 * Return a cached payload if present and still within its TTL, otherwise null.
 * Stale entries are deleted on access.
 * @param {string} key
 * @returns {Promise<{ payload: any, cachedAt: number } | null>}
 */
export async function getCached(key) {
  const row = await selectStmt.get(key);
  if (!row) return null;

  const age = Date.now() - row.created_at;
  if (age > config.cacheTtlMs) {
    await deleteStmt.run(key);
    return null;
  }

  return { payload: JSON.parse(row.payload), cachedAt: row.created_at };
}

/**
 * Store (or refresh) a cached payload.
 * @param {string} key
 * @param {{ game: string, title: string, username: string, platform: string }} meta
 * @param {any} payload  JSON-serialisable value (typically a normalized stats object).
 */
export async function setCached(key, meta, payload) {
  await upsertStmt.run({
    cacheKey: key,
    game: meta.game,
    title: meta.title,
    username: meta.username,
    platform: meta.platform,
    payload: JSON.stringify(payload),
    createdAt: Date.now(),
  });
}

/**
 * The most recently queried stats, newest first, for the dashboard.
 * @param {number} [limit=10]
 * @returns {Promise<Array<{ game: string, title: string, username: string, platform: string, created_at: number }>>}
 */
export async function recentLookups(limit = 10) {
  return recentStmt.all(limit);
}

/**
 * Cached stats rows with their parsed payloads, newest first, for the stats page.
 * @param {number} [limit=50]
 * @returns {Promise<Array<{ game: string, title: string, username: string, platform: string, created_at: number, payload: any }>>}
 */
export async function listCached(limit = 50) {
  return (await listStmt.all(limit)).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}
