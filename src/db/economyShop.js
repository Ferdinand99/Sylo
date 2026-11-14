// Economy shop storage: the items staff sell and what members own.
//
//   economy_items       id, guild_id, name, description, emoji, type ('temp_role' | 'role' | 'custom' |
//                       'collectible'), role_id, duration_ms, price, stock (NULL = unlimited), sold,
//                       required_roles (JSON list, any-of), per_member_limit, enabled, sort_order, and
//                       for a collectible: image_id (the picture, a row of collectible_images, see
//                       db/collectibleImages.js),
//                       rarity (NULL or one of modules/lib/collectibles.js RARITIES), announce (post a
//                       message when it is bought)
//   economy_inventory   id, guild_id, user_id, item_id, item_name / item_type / role_id (a copy of the
//                       item, so a row still reads right after the item was deleted), price_paid,
//                       source ('purchase' | 'grant'), status ('pending' | 'active' | 'revoked' |
//                       'refunded' | 'expired'), fulfilled_at / fulfilled_by / note (custom items:
//                       staff text), added_ms (the time a temporary role purchase added to the
//                       role's record), lease_until (a pending row's role grant may still be running
//                       until then; the sweep leaves it alone), image_id / rarity (a collectible: the
//                       picture and rarity this copy shows. Written when the copy is made and kept in step
//                       with the item while it exists, so the collection still shows it when the item is
//                       removed, or when staff take the picture off the item)
//
// Money and stock NEVER change through this file while a purchase, refund, grant or revoke runs:
// those are transactions in modules/lib/shop.js (through the money API and its `after` hook). This
// file holds the plain reads, the staff's editing of the item list, and the erasure of a member.
// `guild_id` is the server key; the tables are created here for Postgres (SQLite: migration 68).
import { prepare, registerPostgresBootstrap, registerPostgresMigration, transaction } from './driver.js';
import { releaseImageTx, sortedDistinct } from './collectibleImages.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS economy_items (
    id               BIGSERIAL PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    emoji            TEXT NOT NULL DEFAULT '',
    type             TEXT NOT NULL,
    role_id          TEXT,
    duration_ms      BIGINT,
    price            BIGINT NOT NULL,
    stock            BIGINT,
    sold             BIGINT NOT NULL DEFAULT 0,
    required_roles   TEXT NOT NULL DEFAULT '[]',
    per_member_limit INTEGER,
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_economy_items_guild ON economy_items (guild_id, sort_order, id);
  CREATE TABLE IF NOT EXISTS economy_inventory (
    id           BIGSERIAL PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    item_id      BIGINT NOT NULL,
    item_name    TEXT NOT NULL,
    item_type    TEXT NOT NULL,
    role_id      TEXT,
    price_paid   BIGINT NOT NULL DEFAULT 0,
    source       TEXT NOT NULL,
    status       TEXT NOT NULL,
    fulfilled_at BIGINT,
    fulfilled_by TEXT,
    note         TEXT NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
  );
  ALTER TABLE economy_inventory ADD COLUMN IF NOT EXISTS added_ms BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE economy_inventory ADD COLUMN IF NOT EXISTS lease_until BIGINT NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_pending ON economy_inventory (lease_until) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_user ON economy_inventory (guild_id, user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_item ON economy_inventory (guild_id, item_id);
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_created ON economy_inventory (guild_id, created_at);
  -- Collectibles (SQLite migration 74). The columns come before the indexes that use them, so a database
  -- from before them boots.
  ALTER TABLE economy_items ADD COLUMN IF NOT EXISTS image_id TEXT;
  ALTER TABLE economy_items ADD COLUMN IF NOT EXISTS rarity TEXT;
  ALTER TABLE economy_items ADD COLUMN IF NOT EXISTS announce INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE economy_inventory ADD COLUMN IF NOT EXISTS image_id TEXT;
  ALTER TABLE economy_inventory ADD COLUMN IF NOT EXISTS rarity TEXT;
  CREATE INDEX IF NOT EXISTS idx_economy_items_image ON economy_items (image_id) WHERE image_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_image ON economy_inventory (image_id) WHERE image_id IS NOT NULL;
`);

// Mirrors the data step of SQLite migration 71: every temporary-role row that exists before it has an
// unknown added time (-1); from then on 0 means "added nothing". Runs once, so it is a migration.
registerPostgresMigration(71, "UPDATE economy_inventory SET added_ms = -1 WHERE item_type = 'temp_role';");

export const INVENTORY_STATUSES = ['pending', 'active', 'revoked', 'refunded', 'expired'];

const ITEM_COLUMNS = `id, guild_id, name, description, emoji, type, role_id, duration_ms, price, stock, sold,
  required_roles, per_member_limit, enabled, sort_order, image_id, rarity, announce, created_at, updated_at`;

const UPDATE_ITEM_SQL = `UPDATE economy_items SET name = ?, description = ?, emoji = ?, type = ?, role_id = ?,
    duration_ms = ?, price = ?, stock = ?, required_roles = ?, per_member_limit = ?, enabled = ?, rarity = ?,
    announce = ?, updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
  WHERE guild_id = ? AND id = ?`;

const s = {
  insertItem: prepare(
    `INSERT INTO economy_items
       (guild_id, name, description, emoji, type, role_id, duration_ms, price, stock, required_roles,
        per_member_limit, enabled, sort_order, rarity, announce, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { returningId: true }
  ),
  getItem: prepare(`SELECT ${ITEM_COLUMNS} FROM economy_items WHERE guild_id = ? AND id = ?`),
  listItems: prepare(`SELECT ${ITEM_COLUMNS} FROM economy_items WHERE guild_id = ? ORDER BY sort_order, id`),
  countItems: prepare('SELECT COUNT(*) AS n FROM economy_items WHERE guild_id = ?'),
  maxOrder: prepare('SELECT MAX(sort_order) AS m FROM economy_items WHERE guild_id = ?'),
  setEnabled: prepare(
    `UPDATE economy_items SET enabled = ?, updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END WHERE guild_id = ? AND id = ?`
  ),
  setOrder: prepare('UPDATE economy_items SET sort_order = ? WHERE guild_id = ? AND id = ?'),
  getRow: prepare('SELECT * FROM economy_inventory WHERE guild_id = ? AND id = ?'),
  listUser: prepare(
    'SELECT * FROM economy_inventory WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
  ),
  countUser: prepare('SELECT COUNT(*) AS n FROM economy_inventory WHERE guild_id = ? AND user_id = ?'),
  setFulfilled: prepare(
    `UPDATE economy_inventory SET fulfilled_at = ?, fulfilled_by = ?, note = ?, updated_at = ?
     WHERE guild_id = ? AND id = ? AND item_type = 'custom' AND status = 'active' AND fulfilled_at IS NULL`
  ),
  setUnfulfilled: prepare(
    `UPDATE economy_inventory SET fulfilled_at = NULL, fulfilled_by = NULL, updated_at = ?
     WHERE guild_id = ? AND id = ? AND item_type = 'custom' AND status = 'active' AND fulfilled_at IS NOT NULL`
  ),
  stale: prepare(
    `SELECT * FROM economy_inventory WHERE status = 'pending' AND lease_until < ? ORDER BY lease_until, id LIMIT ?`
  ),
  itemStats: prepare(
    `SELECT item_id, COUNT(*) AS purchases, COALESCE(SUM(price_paid), 0) AS revenue
     FROM economy_inventory
     WHERE guild_id = ? AND source = 'purchase' AND status IN ('active', 'pending', 'revoked', 'expired')
     GROUP BY item_id`
  ),
  inventoryOfItem: prepare(
    `SELECT COUNT(*) AS n FROM economy_inventory WHERE guild_id = ? AND item_id = ? AND status IN ('active', 'pending')`
  ),

  expireTemp: prepare(
    `UPDATE economy_inventory SET status = 'expired', updated_at = ?
     WHERE guild_id = ? AND user_id = ? AND role_id = ? AND item_type = 'temp_role' AND status = 'active'`
  ),
  expireTempOfUser: prepare(
    `UPDATE economy_inventory SET status = 'expired', updated_at = ?
     WHERE guild_id = ? AND user_id = ? AND item_type = 'temp_role' AND status = 'active'`
  ),
  liveForRole: prepare(
    `SELECT COUNT(*) AS n FROM economy_inventory
     WHERE guild_id = ? AND user_id = ? AND role_id = ? AND id <> ? AND status IN ('active', 'pending')`
  ),
  liveOfUser: prepare(
    `SELECT * FROM economy_inventory
     WHERE guild_id = ? AND user_id = ? AND item_type <> 'custom' AND role_id IS NOT NULL AND status IN ('active', 'pending')`
  ),
};

/** An item row as the code uses it: numbers as numbers, the role list as an array, flags as booleans. */
export function hydrateItem(row) {
  if (!row) return null;
  let requiredRoles = [];
  try {
    const parsed = JSON.parse(row.required_roles);
    if (Array.isArray(parsed)) requiredRoles = parsed.map(String);
  } catch {
    requiredRoles = [];
  }
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    type: row.type,
    roleId: row.role_id ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    price: Number(row.price),
    stock: row.stock == null ? null : Number(row.stock),
    sold: Number(row.sold),
    requiredRoles,
    perMemberLimit: row.per_member_limit == null ? null : Number(row.per_member_limit),
    enabled: Number(row.enabled) === 1,
    sortOrder: Number(row.sort_order),
    imageId: row.image_id ?? null,
    rarity: row.rarity ?? null,
    announce: Number(row.announce) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** An inventory row as the code uses it. */
export function hydrateRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    itemId: Number(row.item_id),
    itemName: row.item_name,
    itemType: row.item_type,
    roleId: row.role_id ?? null,
    pricePaid: Number(row.price_paid),
    source: row.source,
    status: row.status,
    fulfilledAt: row.fulfilled_at == null ? null : Number(row.fulfilled_at),
    fulfilledBy: row.fulfilled_by ?? null,
    note: row.note,
    addedMs: Number.isFinite(Number(row.added_ms)) ? Number(row.added_ms) : 0,
    leaseUntil: Number(row.lease_until) || 0,
    imageId: row.image_id ?? null,
    rarity: row.rarity ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// --- items (staff editing) ---------------------------------------------------------------------------

/** @param {string} guildId @param {object} v a normalised item (see modules/lib/shop.js normaliseItem) */
export async function createItem(guildId, v, now = Date.now()) {
  const next = Number((await s.maxOrder.get(guildId))?.m ?? -1) + 1;
  const info = await s.insertItem.run(
    guildId,
    v.name,
    v.description,
    v.emoji,
    v.type,
    v.roleId,
    v.durationMs,
    v.price,
    v.stock,
    JSON.stringify(v.requiredRoles),
    v.perMemberLimit,
    v.enabled ? 1 : 0,
    next,
    v.rarity ?? null,
    v.announce ? 1 : 0,
    now,
    now
  );
  return Number(info.lastInsertRowid);
}

export const getItem = async (guildId, id) => hydrateItem(await s.getItem.get(guildId, id));
export const listItems = async (guildId) => (await s.listItems.all(guildId)).map(hydrateItem);
export const itemCount = async (guildId) => Number((await s.countItems.get(guildId))?.n) || 0;

/**
 * Replace the fields of an item (never its stock sold count). Every edit gives the item a new, larger
 * `updated_at`, even two within the same millisecond: it is the version a buyer's confirmation carries.
 * A collectible's rarity is copied to the copies members hold. An item that stops being a collectible lets go of
 * its picture (the members who own a copy keep theirs).
 * @returns {Promise<boolean>} found
 */
export async function updateItem(guildId, id, v, now = Date.now()) {
  return transaction(function* (tx) {
    // Lock the item first, then read its picture: an upload that finished a moment ago has moved it already.
    const lock = yield tx.run(
      'UPDATE economy_items SET sold = sold WHERE guild_id = ? AND id = ?',
      guildId,
      id
    );
    if (lock.changes < 1) return false;
    const cur = yield tx.get('SELECT image_id FROM economy_items WHERE guild_id = ? AND id = ?', guildId, id);
    const info = yield tx.run(
      UPDATE_ITEM_SQL,
      v.name,
      v.description,
      v.emoji,
      v.type,
      v.roleId,
      v.durationMs,
      v.price,
      v.stock,
      JSON.stringify(v.requiredRoles),
      v.perMemberLimit,
      v.enabled ? 1 : 0,
      v.rarity ?? null,
      v.announce ? 1 : 0,
      now,
      now,
      guildId,
      id
    );
    if (info.changes < 1) return false;
    if (v.type === 'collectible') {
      yield tx.run(
        "UPDATE economy_inventory SET rarity = ? WHERE guild_id = ? AND item_id = ? AND item_type = 'collectible'",
        v.rarity ?? null,
        guildId,
        id
      );
    } else if (cur.image_id) {
      yield tx.run('UPDATE economy_items SET image_id = NULL WHERE guild_id = ? AND id = ?', guildId, id);
      yield* releaseImageTx(tx, guildId, cur.image_id);
    }
    return true;
  });
}

export async function setItemEnabled(guildId, id, enabled, now = Date.now()) {
  return (await s.setEnabled.run(enabled ? 1 : 0, now, now, guildId, id)).changes > 0;
}

/** Put the items in the given order (ids not listed keep their relative order after the listed ones). */
export async function reorderItems(guildId, orderedIds) {
  const all = (await listItems(guildId)).map((i) => i.id);
  const wanted = orderedIds.map(Number).filter((id, at, a) => all.includes(id) && a.indexOf(id) === at);
  const rest = all.filter((id) => !wanted.includes(id));
  let at = 0;
  for (const id of [...wanted, ...rest]) await s.setOrder.run(at++, guildId, id);
}

/**
 * Delete an item. The inventory rows stay (they keep a copy of its name, and a collectible's copies keep their
 * picture and rarity, so the members who own it still see it, "item removed"). The picture is deleted in the
 * same transaction when nobody owns a copy.
 * @returns {Promise<boolean>}
 */
export async function deleteItem(guildId, id) {
  return transaction(function* (tx) {
    // Lock the item first, then read its picture: an upload that finished a moment ago has moved it already.
    const lock = yield tx.run(
      'UPDATE economy_items SET sold = sold WHERE guild_id = ? AND id = ?',
      guildId,
      id
    );
    if (lock.changes < 1) return false;
    const item = yield tx.get(
      'SELECT image_id FROM economy_items WHERE guild_id = ? AND id = ?',
      guildId,
      id
    );
    const gone = yield tx.run('DELETE FROM economy_items WHERE guild_id = ? AND id = ?', guildId, id);
    if (gone.changes < 1) return false;
    yield* releaseImageTx(tx, guildId, item.image_id);
    return true;
  });
}

// --- collectibles: a member's collection ------------------------------------------------------------------------

const COLLECTION_WHERE = "guild_id = ? AND user_id = ? AND item_type = 'collectible' AND status = 'active'";

/**
 * One page of a member's collection: the collectibles they own (active rows), one entry per item with how many
 * copies they hold, oldest first. The picture and rarity are the ones the copies carry (kept in step with the
 * item); the item's current name and emoji are used while it exists, the name on the row after it was deleted.
 * @returns {Promise<{ page: number, pages: number, kinds: number, copies: number, entries: object[] }>}
 */
export async function collectionPage(guildId, userId, page = 1, perPage = 10) {
  // COLLECTION_WHERE is a fixed fragment; every value is a bound argument.
  const kinds =
    Number(
      (
        await prepare(
          `SELECT COUNT(DISTINCT item_id) AS n FROM economy_inventory WHERE ${COLLECTION_WHERE}`
        ).get(guildId, userId)
      )?.n
    ) || 0;
  const copies =
    Number(
      (
        await prepare(`SELECT COUNT(*) AS n FROM economy_inventory WHERE ${COLLECTION_WHERE}`).get(
          guildId,
          userId
        )
      )?.n
    ) || 0;
  const pages = Math.max(1, Math.ceil(kinds / perPage));
  const at = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const rows = await prepare(
    `SELECT item_id, MIN(item_name) AS item_name, MIN(image_id) AS image_id, MIN(rarity) AS rarity,
            COUNT(*) AS n, MIN(created_at) AS first_at
     FROM economy_inventory WHERE ${COLLECTION_WHERE}
     GROUP BY item_id ORDER BY MIN(id) LIMIT ? OFFSET ?`
  ).all(guildId, userId, perPage, (at - 1) * perPage);
  const entries = [];
  for (const r of rows) {
    const item = await getItem(guildId, Number(r.item_id));
    entries.push({
      itemId: Number(r.item_id),
      removed: !item,
      name: item?.name ?? r.item_name,
      emoji: item?.emoji ?? '',
      imageId: r.image_id ?? null,
      rarity: r.rarity ?? null,
      count: Number(r.n),
      firstAt: Number(r.first_at),
    });
  }
  return { page: at, pages, kinds, copies, entries };
}

// --- inventory reads -----------------------------------------------------------------------------------

export const getInventoryRow = async (guildId, id) => hydrateRow(await s.getRow.get(guildId, id));
export const listInventory = async (guildId, userId, limit = 100) =>
  (await s.listUser.all(guildId, userId, limit)).map(hydrateRow);
export const inventoryCount = async (guildId, userId) =>
  Number((await s.countUser.get(guildId, userId))?.n) || 0;
/** How many active (or pending) rows hold an item: what is still owned. */
export const heldCount = async (guildId, itemId) =>
  Number((await s.inventoryOfItem.get(guildId, itemId))?.n) || 0;

/** Purchases and revenue per item (refunded purchases do not count). */
export async function itemStats(guildId) {
  const out = new Map();
  for (const r of await s.itemStats.all(guildId)) {
    out.set(Number(r.item_id), { purchases: Number(r.purchases), revenue: Number(r.revenue) });
  }
  return out;
}

/**
 * The activity log: inventory rows newest first, optionally only one member's and/or one item's, and
 * only purchases (default) or every row. Returns `{ rows, total }`.
 */
export async function listActivity(
  guildId,
  { userId = null, itemId = null, purchasesOnly = true, limit = 25, offset = 0 } = {}
) {
  const where = ['guild_id = ?'];
  const args = [guildId];
  if (userId) {
    where.push('user_id = ?');
    args.push(userId);
  }
  if (itemId != null) {
    where.push('item_id = ?');
    args.push(Number(itemId));
  }
  if (purchasesOnly) where.push("source = 'purchase'");
  const clause = where.join(' AND ');
  // The clause is built only from the fixed fragments above; every value is a bound argument.
  const total = Number(
    (await prepare(`SELECT COUNT(*) AS n FROM economy_inventory WHERE ${clause}`).get(...args))?.n
  );
  const rows = await prepare(
    `SELECT * FROM economy_inventory WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args, Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)));
  return { rows: rows.map(hydrateRow), total };
}

/** Rows still waiting for their role grant whose lease ran out before `olderThan` (a restart interrupted them). */
export async function stalePending(olderThan, limit = 50) {
  return (await s.stale.all(olderThan, limit)).map(hydrateRow);
}

/**
 * A temporary role is over (it ran out, was taken off by hand or by staff, or the member left): the
 * member's shop rows for that role stop being active. Called by the temp-role code (modules/tempRoles.js)
 * wherever it drops a record; the shop's own refund and revoke set their own status.
 * @returns {Promise<number>} how many rows
 */
export async function expireShopTempRows(guildId, userId, roleId, now = Date.now()) {
  return (await s.expireTemp.run(now, guildId, userId, roleId)).changes;
}

/** Every temporary-role row of a member ends (the member left, or all their records are dropped). */
export async function expireShopTempRowsOfUser(guildId, userId, now = Date.now()) {
  return (await s.expireTempOfUser.run(now, guildId, userId)).changes;
}

/** How many OTHER live (active or pending) rows of the member hold this role. */
export async function liveRowsForRole(guildId, userId, roleId, exceptId = 0) {
  return Number((await s.liveForRole.get(guildId, userId, roleId, exceptId))?.n) || 0;
}

/** The member's live role rows (temporary and permanent): what /forget takes off. */
export async function liveRoleRows(guildId, userId) {
  return (await s.liveOfUser.all(guildId, userId)).map(hydrateRow);
}

// --- custom items: fulfilment ---------------------------------------------------------------------------

/** Push a pending row's lease forward (the sweep skipped it): it is looked at again after `until`. */
export async function deferPendingLease(guildId, id, until) {
  return (
    (
      await prepare(
        "UPDATE economy_inventory SET lease_until = ? WHERE guild_id = ? AND id = ? AND status = 'pending'"
      ).run(until, guildId, id)
    ).changes > 0
  );
}

/** A role item whose role is on the member: `pending` becomes `active`. */
export async function activateRow(guildId, id, now = Date.now()) {
  return (
    (
      await prepare(
        "UPDATE economy_inventory SET status = 'active', updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'pending'"
      ).run(now, guildId, id)
    ).changes > 0
  );
}

/** Mark a custom item fulfilled. @returns {Promise<boolean>} false when it is not an active, unfulfilled custom item */
export async function markFulfilled(guildId, id, by, note = '', now = Date.now()) {
  return (await s.setFulfilled.run(now, by ?? null, note, now, guildId, id)).changes > 0;
}

export async function markUnfulfilled(guildId, id, now = Date.now()) {
  return (await s.setUnfulfilled.run(now, guildId, id)).changes > 0;
}

// --- erasure ----------------------------------------------------------------------------------------------

/**
 * /forget: delete the member's inventory; take the member's id off rows they fulfilled as staff. One
 * transaction: the pictures that only this member held go with the rows.
 *
 * The pictures to release come from the DELETE itself (RETURNING), not from an earlier read: the delete waits
 * for a row that an upload is moving to a new picture at that moment and then returns the picture the row has
 * NOW, so the picture an upload just put on these rows is released too. They are released in sorted order,
 * after the rows are gone (rows, then pictures, never the item after a row: no cycle with the item-first paths).
 */
export async function eraseInventory(guildId, userId) {
  return transaction(function* (tx) {
    const deleted = yield tx.all(
      'DELETE FROM economy_inventory WHERE guild_id = ? AND user_id = ? RETURNING image_id',
      guildId,
      userId
    );
    const fulfilled = yield tx.run(
      'UPDATE economy_inventory SET fulfilled_by = NULL WHERE guild_id = ? AND fulfilled_by = ?',
      guildId,
      userId
    );
    for (const imageId of sortedDistinct(deleted.map((r) => r.image_id))) {
      yield* releaseImageTx(tx, guildId, imageId);
    }
    return { rows: deleted.length, fulfilled: fulfilled.changes };
  });
}
