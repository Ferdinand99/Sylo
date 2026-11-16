// The server's own look on its public member pages, stored in the database.
//
//   guild_public_look   guild_id, accent ('#rrggbb' or ''), background ('none', 'upload' or 'discord-splash'),
//                       updated_at
//   public_look_images  guild_id, source ('upload' or 'splash'), hash (the first 16 hex characters of the SHA-256
//                       of the stored bytes: it is in the picture's address), mime, bytes, data (BLOB on SQLite,
//                       BYTEA on Postgres), origin (for a splash: the hash Discord or Fluxer gave it, so a
//                       daily check can tell whether it changed without downloading it again), checked_at
//                       (when the splash was last checked), created_at
//
// Like a collectible's picture, what is stored is never what came in: lib/collectibleImage.js decodes it and
// encodes a new WebP of at most BACKGROUND_MAX_SIDE pixels, so metadata and anything that was not a picture are
// gone. There is one picture per source and server, so replacing one deletes the old one in the same statement,
// and the pictures are part of every backup. Both tables hold rows per server and go with the server's data
// (purge.js).
import { prepare, registerPostgresBootstrap } from './driver.js';

/** The background is scaled to fit in a box of this many pixels, at this WebP quality. */
export const BACKGROUND_MAX_SIDE = 1920;
export const BACKGROUND_QUALITY = 78;
/** The two places a background picture comes from. */
export const SOURCES = Object.freeze(['upload', 'splash']);

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_public_look (
    guild_id   TEXT PRIMARY KEY,
    accent     TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT 'none',
    updated_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS public_look_images (
    guild_id   TEXT NOT NULL,
    source     TEXT NOT NULL,
    hash       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    data       BYTEA NOT NULL,
    origin     TEXT NOT NULL DEFAULT '',
    checked_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, source)
  );
  -- A WebP does not compress any further: do not let Postgres try.
  ALTER TABLE public_look_images ALTER COLUMN data SET STORAGE EXTERNAL;
`);

const s = {
  getLook: prepare('SELECT accent, background, updated_at FROM guild_public_look WHERE guild_id = ?'),
  setLook: prepare(`
    INSERT INTO guild_public_look (guild_id, accent, background, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET
      accent = excluded.accent, background = excluded.background, updated_at = excluded.updated_at
  `),
  meta: prepare(
    'SELECT hash, mime, bytes, origin, checked_at, created_at FROM public_look_images WHERE guild_id = ? AND source = ?'
  ),
  put: prepare(`
    INSERT INTO public_look_images (guild_id, source, hash, mime, bytes, data, origin, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, source) DO UPDATE SET
      hash = excluded.hash, mime = excluded.mime, bytes = excluded.bytes, data = excluded.data,
      origin = excluded.origin, checked_at = excluded.checked_at, created_at = excluded.created_at
  `),
  touch: prepare('UPDATE public_look_images SET checked_at = ? WHERE guild_id = ? AND source = ?'),
  drop: prepare('DELETE FROM public_look_images WHERE guild_id = ? AND source = ?'),
  byHash: prepare('SELECT mime, bytes, data FROM public_look_images WHERE guild_id = ? AND hash = ?'),
};

/**
 * What a server chose. Never null: a server that chose nothing has no accent and no background.
 * @returns {Promise<{ accent: string, background: string, updatedAt: number }>}
 */
export async function getPublicLook(guildId) {
  const row = await s.getLook.get(guildId);
  return row
    ? { accent: row.accent, background: row.background, updatedAt: Number(row.updated_at) }
    : { accent: '', background: 'none', updatedAt: 0 };
}

/** Save the choice (already checked by the caller). */
export async function setPublicLook(guildId, { accent, background }, now = Date.now()) {
  await s.setLook.run(guildId, accent, background, now);
}

/**
 * The facts about a stored picture, without its bytes, or null.
 * @param {string} guildId
 * @param {'upload' | 'splash'} source
 * @returns {Promise<{ hash: string, mime: string, bytes: number, origin: string, checkedAt: number, createdAt: number } | null>}
 */
export async function getLookImageMeta(guildId, source) {
  const row = await s.meta.get(guildId, source);
  return row
    ? {
        hash: row.hash,
        mime: row.mime,
        bytes: Number(row.bytes),
        origin: row.origin,
        checkedAt: Number(row.checked_at),
        createdAt: Number(row.created_at),
      }
    : null;
}

/**
 * Store a picture for a source, replacing (and so deleting) the one it had.
 * @param {string} guildId
 * @param {'upload' | 'splash'} source
 * @param {{ hash: string, mime: string, data: Buffer, origin?: string, now?: number }} image
 */
export async function putLookImage(guildId, source, { hash, mime, data, origin = '', now = Date.now() }) {
  await s.put.run(guildId, source, hash, mime, data.length, data, origin, now, now);
}

/** Note that a splash was checked and is still the same picture. */
export async function touchLookImage(guildId, source, now = Date.now()) {
  await s.touch.run(now, guildId, source);
}

/** Delete the picture of a source. @returns {Promise<boolean>} whether there was one */
export async function deleteLookImage(guildId, source) {
  return (await s.drop.run(guildId, source)).changes > 0;
}

/**
 * A stored picture by the hash in its address, for this server only, or null.
 * @returns {Promise<{ mime: string, bytes: number, data: Buffer } | null>}
 */
export async function readLookImage(guildId, hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{16}$/.test(hash)) return null;
  const row = await s.byHash.get(guildId, hash);
  return row ? { mime: row.mime, bytes: Number(row.bytes), data: Buffer.from(row.data) } : null;
}
