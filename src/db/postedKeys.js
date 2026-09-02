// One generic "have we already posted this?" store for the alert modules
// (free games, Twitch, YouTube, and — from 3.9 — RSS). Rows are keyed by
// (guild_id, scope, key); `value` optionally carries what was announced, e.g.
// the Twitch stream id or YouTube live video id, so a *new* broadcast by the
// same channel can be told apart from the one already announced.
import { db } from './index.js';

const stmts = {
  get: db.prepare('SELECT value FROM posted_keys WHERE guild_id = ? AND scope = ? AND key = ?'),
  anyInScope: db.prepare('SELECT 1 FROM posted_keys WHERE guild_id = ? AND scope = ? LIMIT 1'),
  anyMatch: db.prepare('SELECT 1 FROM posted_keys WHERE guild_id = ? AND scope = ? AND key GLOB ? LIMIT 1'),
  insert: db.prepare(`
    INSERT OR IGNORE INTO posted_keys (guild_id, scope, key, value, posted_at)
    VALUES (@guildId, @scope, @key, @value, @now)
  `),
  upsert: db.prepare(`
    INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
    VALUES (@guildId, @scope, @key, @value, @now)
    ON CONFLICT (guild_id, scope, key) DO UPDATE SET value = excluded.value, posted_at = excluded.posted_at
  `),
  del: db.prepare('DELETE FROM posted_keys WHERE guild_id = ? AND scope = ? AND key = ?'),
  clearScope: db.prepare('DELETE FROM posted_keys WHERE guild_id = ? AND scope = ?'),
  clearGuild: db.prepare('DELETE FROM posted_keys WHERE guild_id = ?'),
  prune: db.prepare('DELETE FROM posted_keys WHERE scope = ? AND posted_at < ?'),
  prunePrefix: db.prepare('DELETE FROM posted_keys WHERE scope LIKE ? AND posted_at < ?'),
};

/** Have we recorded this key? */
export function seen(guildId, scope, key) {
  return stmts.get.get(guildId, scope, key) != null;
}

/** The stored value for this key, or null (also null when the key is absent). */
export function seenValue(guildId, scope, key) {
  return stmts.get.get(guildId, scope, key)?.value ?? null;
}

/** Has anything been recorded in this scope for this guild yet? */
export function anySeen(guildId, scope) {
  return stmts.anyInScope.get(guildId, scope) != null;
}

/**
 * Is any key in this scope matching a GLOB pattern present? The pattern must be
 * a literal prefix followed by `*` so SQLite can use the primary-key index.
 */
export function anySeenMatching(guildId, scope, keyGlob) {
  return stmts.anyMatch.get(guildId, scope, keyGlob) != null;
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
export function markSeen(guildId, scope, key, value = null, { upsert = false } = {}) {
  (upsert ? stmts.upsert : stmts.insert).run({ guildId, scope, key, value, now: Date.now() });
}

/** Drop a single key (e.g. a stream went offline). */
export function forget(guildId, scope, key) {
  stmts.del.run(guildId, scope, key);
}

/** Drop every key in one scope for one guild. */
export function clearScope(guildId, scope) {
  stmts.clearScope.run(guildId, scope);
}

/** Drop every posted key for a guild (guild-leave purge). */
export function clearGuildPostedKeys(guildId) {
  stmts.clearGuild.run(guildId);
}

/** Drop keys in a scope older than `ms` milliseconds. */
export function pruneScopeOlderThan(scope, ms) {
  stmts.prune.run(scope, Date.now() - ms);
}

/**
 * Drop keys older than `ms` across every scope starting with `prefix` (a literal
 * prefix; `%` and `_` in it are treated literally enough for our scope names).
 * Used by RSS, whose scopes are `rss:<feedId>`.
 */
export function pruneScopePrefixOlderThan(prefix, ms) {
  stmts.prunePrefix.run(`${prefix}%`, Date.now() - ms);
}
