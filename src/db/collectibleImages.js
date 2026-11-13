// The pictures of collectibles (the Economy shop), stored in the database.
//
//   collectible_images   id (128 random bits as 32 lower-case hex characters: the public address
//                        /c/<id>.webp), guild_id, mime, bytes (the size of data), data (the picture:
//                        BLOB on SQLite, BYTEA on Postgres), created_at
//
// What is stored is never what was uploaded: lib/collectibleImage.js decodes the upload and encodes a new
// WebP of at most 512x512, and that is the only thing that gets here. The pictures live in the database so
// they are part of every backup (the Health page, the scheduled ones, the off-site copy) and a restore
// brings back exactly the pictures the restored rows refer to.
//
// A picture is referenced by an item (economy_items.image_id) and by the inventory rows that carry a copy of
// the reference (economy_inventory.image_id, active rows only count). It is deleted in the SAME transaction as
// the change that drops its last reference (`releaseImageTx`): replacing or removing a picture, deleting an
// item, ending a copy (revoke, refund), erasing a member. So there is never a picture nothing refers to, and
// never a reference to a picture that is gone.
//
// A server may store at most MAX_IMAGES_PER_GUILD pictures and MAX_IMAGE_BYTES_PER_GUILD bytes of them (the
// check is part of the upload's transaction). The picture is kept out of every item and inventory read: it is
// only read by `readImage`, by its id.
import { randomBytes } from 'node:crypto';
import { prepare, registerPostgresBootstrap, transaction } from './driver.js';

/** An image id: 128 random bits, lower-case hex. */
export const IMAGE_ID_RE = /^[0-9a-f]{32}$/;
/** At most this many pictures per server (every stored picture counts). */
export const MAX_IMAGES_PER_GUILD = 200;
/** At most this many bytes of pictures per server. */
export const MAX_IMAGE_BYTES_PER_GUILD = 25 * 1024 * 1024;

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS collectible_images (
    id         TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    data       BYTEA NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_collectible_images_guild ON collectible_images (guild_id);
  -- A WebP does not compress any further: do not let Postgres try.
  ALTER TABLE collectible_images ALTER COLUMN data SET STORAGE EXTERNAL;
`);

const s = {
  get: prepare('SELECT mime, bytes, data FROM collectible_images WHERE id = ?'),
  usage: prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM collectible_images WHERE guild_id = ?'
  ),
};

/**
 * A picture by its id, or null for an id of the wrong shape or one that does not exist.
 * @returns {Promise<{ mime: string, bytes: number, data: Buffer } | null>}
 */
export async function readImage(imageId) {
  if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) return null;
  const row = await s.get.get(imageId);
  return row ? { mime: row.mime, bytes: Number(row.bytes), data: Buffer.from(row.data) } : null;
}

/** How many pictures a server stores and how many bytes they take. */
export async function imageUsage(guildId) {
  const row = await s.usage.get(guildId);
  return { count: Number(row?.n) || 0, bytes: Number(row?.b) || 0 };
}

// Delete a picture when nothing refers to it any more: no item, and no active (or pending) inventory row.
const RELEASE_SQL = `DELETE FROM collectible_images
  WHERE guild_id = ? AND id = ?
    AND NOT EXISTS (SELECT 1 FROM economy_items WHERE guild_id = ? AND image_id = ?)
    AND NOT EXISTS (SELECT 1 FROM economy_inventory
                    WHERE guild_id = ? AND image_id = ? AND status IN ('active', 'pending'))`;

/**
 * Inside a transaction() body (`yield*` it, after the statement that dropped a reference): delete the
 * picture if nothing refers to it any more.
 * @returns {Generator<any, boolean, any>} whether it was deleted
 */
export function* releaseImageTx(tx, guildId, imageId) {
  if (!imageId) return false;
  const out = yield tx.run(RELEASE_SQL, guildId, imageId, guildId, imageId, guildId, imageId);
  return out.changes > 0;
}

// The same bump every staff edit gives an item: its version, which a buyer's confirmation carries.
const BUMP = 'updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END';

/**
 * Give a collectible a new picture. One transaction: the item is locked (the same row lock a purchase takes),
 * the server's quota is checked, the picture is stored, the item and the live rows of the item point at it
 * (an owner sees the item's current picture), and the picture it had is deleted. Like every edit this moves
 * the item's version, so a buyer who saw the old picture is told to look again.
 * @param {string} guildId
 * @param {number} itemId
 * @param {{ mime: string, data: Buffer, now?: number }} image  what lib/collectibleImage.js produced
 * @returns {Promise<{ ok: true, imageId: string } | { ok: false, reason: 'gone' | 'quota', count?: number, bytes?: number }>}
 */
export async function attachImage(guildId, itemId, { mime, data, now = Date.now() }) {
  const imageId = randomBytes(16).toString('hex');
  return transaction(function* (tx) {
    const lock = yield tx.run(
      "UPDATE economy_items SET sold = sold WHERE guild_id = ? AND id = ? AND type = 'collectible'",
      guildId,
      itemId
    );
    if (lock.changes !== 1) return { ok: false, reason: 'gone' };
    const item = yield tx.get(
      'SELECT image_id FROM economy_items WHERE guild_id = ? AND id = ?',
      guildId,
      itemId
    );
    // The pictures being replaced: the one the item has, and the ones its live copies carry (after the picture
    // was taken off the item the copies still hold the old one). They are referenced by this item and its
    // copies only, and all of them move to the new picture, so they are freed: they do not count against the
    // quota of the new picture.
    const held = yield tx.all(
      `SELECT DISTINCT image_id FROM economy_inventory
       WHERE guild_id = ? AND item_id = ? AND item_type = 'collectible' AND status IN ('active', 'pending')
         AND image_id IS NOT NULL`,
      guildId,
      itemId
    );
    const olds = [...new Set([item.image_id, ...held.map((r) => r.image_id)].filter(Boolean))];
    let freedCount = 0;
    let freedBytes = 0;
    for (const oldId of olds) {
      const old = yield tx.get(
        'SELECT bytes FROM collectible_images WHERE guild_id = ? AND id = ?',
        guildId,
        oldId
      );
      if (old) {
        freedCount += 1;
        freedBytes += Number(old.bytes);
      }
    }
    const use = yield tx.get(
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM collectible_images WHERE guild_id = ?',
      guildId
    );
    const count = Number(use.n) - freedCount + 1;
    const bytes = Number(use.b) - freedBytes + data.length;
    if (count > MAX_IMAGES_PER_GUILD || bytes > MAX_IMAGE_BYTES_PER_GUILD) {
      return { ok: false, reason: 'quota', count: Number(use.n), bytes: Number(use.b) };
    }
    yield tx.run(
      'INSERT INTO collectible_images (id, guild_id, mime, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      imageId,
      guildId,
      mime,
      data.length,
      data,
      now
    );
    yield tx.run(
      `UPDATE economy_items SET image_id = ?, ${BUMP} WHERE guild_id = ? AND id = ?`,
      imageId,
      now,
      now,
      guildId,
      itemId
    );
    yield tx.run(
      `UPDATE economy_inventory SET image_id = ?
       WHERE guild_id = ? AND item_id = ? AND item_type = 'collectible' AND status IN ('active', 'pending')`,
      imageId,
      guildId,
      itemId
    );
    for (const oldId of olds) yield* releaseImageTx(tx, guildId, oldId);
    return { ok: true, imageId };
  });
}

/**
 * Take the picture off an item. Only the item lets go of it: the members who own the item keep the picture
 * they hold (it goes when the last of them lets go).
 * @returns {Promise<boolean>} whether the item had a picture
 */
export async function detachImage(guildId, itemId, now = Date.now()) {
  return transaction(function* (tx) {
    const lock = yield tx.run(
      'UPDATE economy_items SET sold = sold WHERE guild_id = ? AND id = ?',
      guildId,
      itemId
    );
    if (lock.changes !== 1) return false;
    const item = yield tx.get(
      'SELECT image_id FROM economy_items WHERE guild_id = ? AND id = ?',
      guildId,
      itemId
    );
    if (!item.image_id) return false;
    yield tx.run(
      `UPDATE economy_items SET image_id = NULL, ${BUMP} WHERE guild_id = ? AND id = ?`,
      now,
      now,
      guildId,
      itemId
    );
    yield* releaseImageTx(tx, guildId, item.image_id);
    return true;
  });
}
