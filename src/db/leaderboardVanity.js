// Vanity URL for a guild's public leaderboard: a short unique slug that
// redirects /lb/<slug> to /leaderboard/<guildId>.
import { db } from './index.js';

// 3–32 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** Clean a user-entered slug, or null if it can't be made valid. */
export function normaliseVanitySlug(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return SLUG_RE.test(s) ? s : null;
}

const stmts = {
  get: db.prepare('SELECT slug FROM leaderboard_vanity WHERE guild_id = ?'),
  owner: db.prepare('SELECT guild_id FROM leaderboard_vanity WHERE slug = ?'),
  upsert: db.prepare(`
    INSERT INTO leaderboard_vanity (guild_id, slug, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET slug = excluded.slug, updated_at = excluded.updated_at
  `),
  del: db.prepare('DELETE FROM leaderboard_vanity WHERE guild_id = ?'),
};

export const getVanitySlug = (guildId) => stmts.get.get(guildId)?.slug ?? null;
export const guildForVanity = (slug) => stmts.owner.get(String(slug ?? '').toLowerCase())?.guild_id ?? null;
export const clearVanitySlug = (guildId) => stmts.del.run(guildId);

/**
 * Claim a slug for a guild. Returns `{ ok: true, slug }` or
 * `{ ok: false, error: 'invalid' | 'taken' }`.
 */
export function setVanitySlug(guildId, rawSlug) {
  const slug = normaliseVanitySlug(rawSlug);
  if (!slug) return { ok: false, error: 'invalid' };
  const owner = guildForVanity(slug);
  if (owner && owner !== guildId) return { ok: false, error: 'taken' };
  stmts.upsert.run(guildId, slug, Date.now());
  return { ok: true, slug };
}
