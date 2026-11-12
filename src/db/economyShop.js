// Economy shop storage: the items staff sell and what members own.
//
//   economy_items       id, guild_id, name, description, emoji, type ('temp_role' | 'role' | 'custom'),
//                       role_id, duration_ms, price, stock (NULL = unlimited), sold, required_roles
//                       (JSON list, any-of), per_member_limit, enabled, sort_order
//   economy_inventory   id, guild_id, user_id, item_id, item_name / item_type / role_id (a copy of the
//                       item, so a row still reads right after the item was deleted), price_paid,
//                       source ('purchase' | 'grant'), status ('pending' | 'active' | 'revoked' |
//                       'refunded'), fulfilled_at / fulfilled_by / note (custom items: staff text)
//
// Money and stock NEVER change through this file while a purchase, refund, grant or revoke runs:
// those are transactions in modules/lib/shop.js (through the money API and its `after` hook). This
// file holds the plain reads, the staff's editing of the item list, and the erasure of a member.
// `guild_id` is the server key; the tables are created here for Postgres (SQLite: migration 68).
import { prepare, registerPostgresBootstrap } from './driver.js';

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
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_user ON economy_inventory (guild_id, user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_item ON economy_inventory (guild_id, item_id);
  CREATE INDEX IF NOT EXISTS idx_economy_inventory_created ON economy_inventory (guild_id, created_at);
`);

export const INVENTORY_STATUSES = ['pending', 'active', 'revoked', 'refunded'];

const ITEM_COLUMNS = `id, guild_id, name, description, emoji, type, role_id, duration_ms, price, stock, sold,
  required_roles, per_member_limit, enabled, sort_order, created_at, updated_at`;

const s = {
  insertItem: prepare(
    `INSERT INTO economy_items
       (guild_id, name, description, emoji, type, role_id, duration_ms, price, stock, required_roles,
        per_member_limit, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { returningId: true }
  ),
  getItem: prepare(`SELECT ${ITEM_COLUMNS} FROM economy_items WHERE guild_id = ? AND id = ?`),
  listItems: prepare(`SELECT ${ITEM_COLUMNS} FROM economy_items WHERE guild_id = ? ORDER BY sort_order, id`),
  countItems: prepare('SELECT COUNT(*) AS n FROM economy_items WHERE guild_id = ?'),
  maxOrder: prepare('SELECT MAX(sort_order) AS m FROM economy_items WHERE guild_id = ?'),
  updateItem: prepare(
    `UPDATE economy_items SET name = ?, description = ?, emoji = ?, type = ?, role_id = ?, duration_ms = ?,
       price = ?, stock = ?, required_roles = ?, per_member_limit = ?, enabled = ?, updated_at = ?
     WHERE guild_id = ? AND id = ?`
  ),
  setEnabled: prepare('UPDATE economy_items SET enabled = ?, updated_at = ? WHERE guild_id = ? AND id = ?'),
  setOrder: prepare('UPDATE economy_items SET sort_order = ? WHERE guild_id = ? AND id = ?'),
  deleteItem: prepare('DELETE FROM economy_items WHERE guild_id = ? AND id = ?'),

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
    `SELECT * FROM economy_inventory WHERE status = 'pending' AND created_at < ? ORDER BY id LIMIT ?`
  ),
  itemStats: prepare(
    `SELECT item_id, COUNT(*) AS purchases, COALESCE(SUM(price_paid), 0) AS revenue
     FROM economy_inventory
     WHERE guild_id = ? AND source = 'purchase' AND status IN ('active', 'pending', 'revoked')
     GROUP BY item_id`
  ),
  inventoryOfItem: prepare(
    `SELECT COUNT(*) AS n FROM economy_inventory WHERE guild_id = ? AND item_id = ? AND status IN ('active', 'pending')`
  ),

  eraseUser: prepare('DELETE FROM economy_inventory WHERE guild_id = ? AND user_id = ?'),
  eraseFulfiller: prepare(
    'UPDATE economy_inventory SET fulfilled_by = NULL WHERE guild_id = ? AND fulfilled_by = ?'
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
    now,
    now
  );
  return Number(info.lastInsertRowid);
}

export const getItem = async (guildId, id) => hydrateItem(await s.getItem.get(guildId, id));
export const listItems = async (guildId) => (await s.listItems.all(guildId)).map(hydrateItem);
export const itemCount = async (guildId) => Number((await s.countItems.get(guildId))?.n) || 0;

/** Replace the fields of an item (never its stock sold count). @returns {Promise<boolean>} found */
export async function updateItem(guildId, id, v, now = Date.now()) {
  const info = await s.updateItem.run(
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
    now,
    guildId,
    id
  );
  return info.changes > 0;
}

export async function setItemEnabled(guildId, id, enabled, now = Date.now()) {
  return (await s.setEnabled.run(enabled ? 1 : 0, now, guildId, id)).changes > 0;
}

/** Put the items in the given order (ids not listed keep their relative order after the listed ones). */
export async function reorderItems(guildId, orderedIds) {
  const all = (await listItems(guildId)).map((i) => i.id);
  const wanted = orderedIds.map(Number).filter((id, at, a) => all.includes(id) && a.indexOf(id) === at);
  const rest = all.filter((id) => !wanted.includes(id));
  let at = 0;
  for (const id of [...wanted, ...rest]) await s.setOrder.run(at++, guildId, id);
}

/** Delete an item. The inventory rows stay (they keep a copy of its name). @returns {Promise<boolean>} */
export async function deleteItem(guildId, id) {
  return (await s.deleteItem.run(guildId, id)).changes > 0;
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

/** Rows still waiting for their role grant after `olderThan` ms epoch (a restart interrupted them). */
export async function stalePending(olderThan, limit = 50) {
  return (await s.stale.all(olderThan, limit)).map(hydrateRow);
}

// --- custom items: fulfilment ---------------------------------------------------------------------------

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

/** /forget: delete the member's inventory; take the member's id off rows they fulfilled as staff. */
export async function eraseInventory(guildId, userId) {
  const rows = (await s.eraseUser.run(guildId, userId)).changes;
  const fulfilled = (await s.eraseFulfiller.run(guildId, userId)).changes;
  return { rows, fulfilled };
}
