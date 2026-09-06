// One generic "have we already posted this?" store for the alert modules
// (free games, Twitch, YouTube, and — from 3.9 — RSS). Rows are keyed by
// (guild_id, scope, key); `value` optionally carries what was announced, e.g.
// the Twitch stream id or YouTube live video id, so a *new* broadcast by the
// same channel can be told apart from the one already announced.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS posted_keys (
    guild_id  TEXT NOT NULL,
    scope     TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT,
    posted_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, scope, key)
  );
  CREATE INDEX IF NOT EXISTS idx_posted_keys_prune ON posted_keys (scope, posted_at);
`);

const stmts = {
  get: prepare('SELECT value, posted_at FROM posted_keys WHERE guild_id = ? AND scope = ? AND key = ?'),
  anyInScope: prepare('SELECT 1 FROM posted_keys WHERE guild_id = ? AND scope = ? LIMIT 1'),
  // `key GLOB ?` (SQLite-only) rewritten to a plain `LIKE` — the only pattern
  // this is ever called with is a literal prefix + wildcard (see
  // anySeenMatching below, which converts the glob-style `*` to `%` before
  // binding), so LIKE's semantics are equivalent here and this works
  // identically on both drivers.
  anyMatch: prepare('SELECT 1 FROM posted_keys WHERE guild_id = ? AND scope = ? AND key LIKE ? LIMIT 1'),
  // `INSERT OR IGNORE` (SQLite-only) rewritten to the standard `ON CONFLICT
  // DO NOTHING`, which SQLite has also supported since 3.24 — this is the
  // same statement on both drivers, not a driver-specific branch.
  insert: prepare(`
    INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
    VALUES (@guildId, @scope, @key, @value, @now)
    ON CONFLICT (guild_id, scope, key) DO NOTHING
  `),
  upsert: prepare(`
    INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
    VALUES (@guildId, @scope, @key, @value, @now)
    ON CONFLICT (guild_id, scope, key) DO UPDATE SET value = excluded.value, posted_at = excluded.posted_at
  `),
  del: prepare('DELETE FROM posted_keys WHERE guild_id = ? AND scope = ? AND key = ?'),
  clearScope: prepare('DELETE FROM posted_keys WHERE guild_id = ? AND scope = ?'),
  clearGuild: prepare('DELETE FROM posted_keys WHERE guild_id = ?'),
  prune: prepare('DELETE FROM posted_keys WHERE scope = ? AND posted_at < ?'),
  prunePrefix: prepare('DELETE FROM posted_keys WHERE scope LIKE ? AND posted_at < ?'),
};

/** Have we recorded this key? */
export async function seen(guildId, scope, key) {
  return (await stmts.get.get(guildId, scope, key)) != null;
}

/** The stored value for this key, or null (also null when the key is absent). */
export async function seenValue(guildId, scope, key) {
  return (await stmts.get.get(guildId, scope, key))?.value ?? null;
}

/** The full row (`{ value, posted_at }`) for this key, or null. */
export async function seenRow(guildId, scope, key) {
  return (await stmts.get.get(guildId, scope, key)) ?? null;
}

/** Has anything been recorded in this scope for this guild yet? */
export async function anySeen(guildId, scope) {
  return (await stmts.anyInScope.get(guildId, scope)) != null;
}

/**
 * Is any key in this scope matching a glob-style pattern present? The pattern
 * must be a literal prefix followed by `*` (translated to `%` for the LIKE
 * query the statement actually runs).
 */
export async function anySeenMatching(guildId, scope, keyGlob) {
  const likePattern = keyGlob.replace(/\*/g, '%');
  return (await stmts.anyMatch.get(guildId, scope, likePattern)) != null;
}

/**
 * Record a key as posted.
 * @param {string} guildId
 * @param {string} scope
 * @param {string} key
 * @param {string|null} [value]
 * @param {{ upsert?: boolean }} [opts]  upsert:true refreshes value + posted_at
 *   for an existing key; the default leaves an existing row untouched.
 */
export async function markSeen(guildId, scope, key, value = null, { upsert = false } = {}) {
  await (upsert ? stmts.upsert : stmts.insert).run({ guildId, scope, key, value, now: Date.now() });
}

/** Drop a single key (e.g. a stream went offline). */
export async function forget(guildId, scope, key) {
  await stmts.del.run(guildId, scope, key);
}

/** Drop every key in one scope for one guild. */
export async function clearScope(guildId, scope) {
  await stmts.clearScope.run(guildId, scope);
}

/** Drop every posted key for a guild (guild-leave purge). */
export async function clearGuildPostedKeys(guildId) {
  await stmts.clearGuild.run(guildId);
}

/** Drop keys in a scope older than `ms` milliseconds. */
export async function pruneScopeOlderThan(scope, ms) {
  await stmts.prune.run(scope, Date.now() - ms);
}

/**
 * Drop keys older than `ms` across every scope starting with `prefix` (a literal
 * prefix; `%` and `_` in it are treated literally enough for our scope names).
 * Used by RSS, whose scopes are `rss:<feedId>`.
 */
export async function pruneScopePrefixOlderThan(prefix, ms) {
  await stmts.prunePrefix.run(`${prefix}%`, Date.now() - ms);
}
