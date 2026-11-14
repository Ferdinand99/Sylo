// JSON API for the shop part of the Economy page: the items (create, edit, pause, reorder, delete, and the
// picture of a collectible), a member's inventory (give an item for free, revoke it, refund a purchase, mark
// a custom item fulfilled) and the activity log of purchases. Every change goes through modules/lib/shop.js, which
// uses the money API and writes the ledger, exactly like the commands and the web shop.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check. A role an item hands
// out must be one the caller could hand out themselves (checkRoleGrants).
import { Router } from 'express';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { checkRoleGrants } from '../middleware/roleGrants.js';
import { clientKey, platformActionLimit, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { getTempRole } from '../../db/tempRoles.js';
import {
  createItem,
  deleteItem,
  getInventoryRow,
  getItem,
  heldCount,
  itemCount,
  itemStats,
  listActivity,
  listInventory,
  listItems,
  markFulfilled,
  markUnfulfilled,
  reorderItems,
  setItemEnabled,
  updateItem,
} from '../../db/economyShop.js';
import {
  MAX_IMAGES_PER_GUILD,
  MAX_IMAGE_BYTES_PER_GUILD,
  attachImage,
  detachImage,
  imageUsage,
} from '../../db/collectibleImages.js';
import { ImageError, processImage, readUpload } from '../../lib/collectibleImage.js';
import { RARITIES, isRoleItemType } from '../../modules/lib/economyConfig.js';
import { LIMITS as CEILINGS, checkLimit } from '../../lib/limits.js';
import { economySettings, itemProblem, normaliseItem, normaliseReason } from '../../modules/economy.js';
import { endRow, grantItem, shopRefusalText } from '../../modules/lib/shop.js';

const router = Router({ mergeParams: true });

const ACTIVITY_PAGE = 25;
const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });
const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));
const isItemId = (v) => /^\d{1,15}$/.test(String(v ?? ''));

/** The path of a picture on this site (the dashboard shows it; a message uses the full address instead). */
const imagePathOf = (imageId) => (imageId ? `/c/${imageId}.webp` : null);

/** The staff-facing form of an item: its fields, how much is left, and what it has sold. */
const itemView = (item, stats) => ({
  id: item.id,
  name: item.name,
  description: item.description,
  emoji: item.emoji,
  type: item.type,
  roleId: item.roleId,
  durationHours: item.durationMs == null ? null : Math.round(item.durationMs / 3_600_000),
  price: item.price,
  stock: item.stock,
  sold: item.sold,
  left: item.stock === null ? null : Math.max(0, item.stock - item.sold),
  requiredRoles: item.requiredRoles,
  perMemberLimit: item.perMemberLimit,
  enabled: item.enabled,
  sortOrder: item.sortOrder,
  rarity: item.rarity,
  announce: item.announce,
  imagePath: item.type === 'collectible' ? imagePathOf(item.imageId) : null,
  purchases: stats?.purchases ?? 0,
  revenue: stats?.revenue ?? 0,
});

/** How much of the server's picture quota the collectibles use, for the counter on the shop page. */
async function picturesPayload(guild) {
  const { count, bytes } = await imageUsage(guild.id);
  return { count, bytes, maxCount: MAX_IMAGES_PER_GUILD, maxBytes: MAX_IMAGE_BYTES_PER_GUILD };
}

async function itemsPayload(guild) {
  const [items, stats] = await Promise.all([listItems(guild.id), itemStats(guild.id)]);
  return items.map((i) => itemView(i, stats.get(i.id)));
}

/** A person for the page: the name Sylo knows, and whether they are still here. */
function personOf(guild, userId) {
  if (!userId) return null;
  const member = guild.members?.cache?.get?.(userId);
  return { id: userId, name: member?.displayName ?? userId, inServer: Boolean(member) };
}

/**
 * An inventory row for the page, with the end time of a temp role and whether its item still exists. `items`
 * maps the ids of the server's items to the items.
 */
export async function rowView(guild, row, items) {
  const item = items.get(row.itemId);
  let expiresAt = null;
  if (row.itemType === 'temp_role' && row.roleId && (row.status === 'active' || row.status === 'pending')) {
    expiresAt = (await getTempRole(guild.id, row.userId, row.roleId))?.expires_at ?? null;
  }
  return {
    id: row.id,
    userId: row.userId,
    member: personOf(guild, row.userId),
    itemId: row.itemId,
    itemName: row.itemName,
    itemType: row.itemType,
    itemRemoved: !item,
    roleId: row.roleId,
    // the picture and rarity this copy carries (kept in step with the item, and kept when the item is removed).
    // A refunded or revoked copy no longer holds its picture, which may be gone: no picture then (the page
    // shows the word "collectible" instead of a broken image).
    imagePath:
      row.itemType === 'collectible' && (row.status === 'active' || row.status === 'pending')
        ? imagePathOf(row.imageId)
        : null,
    rarity: row.itemType === 'collectible' ? row.rarity : null,
    pricePaid: row.pricePaid,
    source: row.source,
    status: row.status,
    expiresAt,
    fulfilledAt: row.fulfilledAt,
    fulfilledBy: personOf(guild, row.fulfilledBy),
    note: row.note,
    createdAt: row.createdAt,
  };
}

/** A member's inventory as the page shows it (also used by the member panel of routes/v2Economy.js). */
export async function inventoryPayload(guild, userId) {
  const items = new Map((await listItems(guild.id)).map((i) => [i.id, i]));
  const rows = await listInventory(guild.id, userId, 100);
  return Promise.all(rows.map((r) => rowView(guild, r, items)));
}

/**
 * The shop actions that put a role on or take it off a member call the platform, so they share the
 * stricter limit for dashboard actions that do. Checked synchronously after validation.
 */
function withinPlatformLimit(req, res) {
  let allowed = false;
  platformActionLimit(req, res, () => {
    allowed = true;
  });
  return allowed;
}

/** The role of an item must be one the caller may hand out, and one the server really has. */
function roleProblem(req, res, guild, item) {
  if (!isRoleItemType(item.type)) return false;
  if (!assignableRoles(guild).some((r) => r.id === item.roleId)) {
    fail(res, 'Pick a role from the list.');
    return true;
  }
  checkRoleGrants([item.roleId]); // throws a RoleGrantError (403) for a role the person may not hand out
  return false;
}

// --- items -----------------------------------------------------------------------------------------------

router.get(
  '/modules/economy/shop/items',
  asyncHandler(async (req, res) => {
    res.json({
      items: await itemsPayload(req.guild),
      pictures: await picturesPayload(req.guild),
      roles: assignableRoles(req.guild),
      channels: guildTextChannels(req.guild),
      maxItems: CEILINGS.shopItems,
      rarities: RARITIES.map(({ key, label }) => ({ key, label })),
    });
  })
);

router.post(
  '/modules/economy/shop/items',
  asyncHandler(async (req, res) => {
    const item = normaliseItem(req.body);
    const problem = itemProblem(item);
    if (problem) return fail(res, problem);
    if (roleProblem(req, res, req.guild, item)) return undefined;
    checkLimit(await itemCount(req.guild.id), CEILINGS.shopItems, 'shop items');
    const id = await createItem(req.guild.id, item);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `added item #${id} ${item.name}`,
    });
    res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild), id });
  })
);

router.post(
  '/modules/economy/shop/items/order',
  asyncHandler(async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isItemId);
    await reorderItems(req.guild.id, ids);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: 'reordered the items',
    });
    res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild) });
  })
);

router.post(
  '/modules/economy/shop/items/:id',
  asyncHandler(async (req, res) => {
    if (!isItemId(req.params.id)) return fail(res, 'Unknown item.', 404);
    const id = Number(req.params.id);
    if (!(await getItem(req.guild.id, id))) return fail(res, 'Unknown item.', 404);
    const item = normaliseItem(req.body);
    const problem = itemProblem(item);
    if (problem) return fail(res, problem);
    if (roleProblem(req, res, req.guild, item)) return undefined;
    await updateItem(req.guild.id, id, item);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `edited item #${id} ${item.name}`,
    });
    res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild) });
  })
);

router.post(
  '/modules/economy/shop/items/:id/enabled',
  asyncHandler(async (req, res) => {
    if (!isItemId(req.params.id)) return fail(res, 'Unknown item.', 404);
    const id = Number(req.params.id);
    const enabled = req.body?.enabled === true;
    if (!(await setItemEnabled(req.guild.id, id, enabled))) return fail(res, 'Unknown item.', 404);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `${enabled ? 'resumed' : 'paused'} item #${id}`,
    });
    res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild) });
  })
);

// Deleting an item keeps what members own: their inventory rows keep the item's name and show as
// "item removed". A role item that members still hold keeps working until it is revoked or runs out.
router.post(
  '/modules/economy/shop/items/:id/delete',
  asyncHandler(async (req, res) => {
    if (!isItemId(req.params.id)) return fail(res, 'Unknown item.', 404);
    const id = Number(req.params.id);
    const held = await heldCount(req.guild.id, id);
    if (!(await deleteItem(req.guild.id, id))) return fail(res, 'Unknown item.', 404);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `deleted item #${id} (${held} still held)`,
    });
    res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild), held });
  })
);

// --- the picture of a collectible -------------------------------------------------------------------------------
//
// A multipart upload (the field `file`), at most 2 MB. The kind is decided by the magic bytes and the picture is
// decoded and re-encoded as a WebP of at most 512x512 (lib/collectibleImage.js), so what is stored is never what
// was sent; at most two pictures are decoded at a time. Only the staff of this server get here (the admin guard)
// and the CSRF check has passed. The picture is stored in the database (db/collectibleImages.js): a new one
// replaces the old one in one transaction, within the server's quota of 200 pictures and 25 MB. Uploads of one
// server take turns, so two at once cannot both slip under the quota.

const imageUploadLimit = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: 'Too many uploads: wait a minute and try again.',
  keyFn: (req) => `coll-image|${req.params?.guildId ?? ''}|${clientKey(req)}`,
});

const imageChains = new Map();
/** Run `fn` after every earlier call with the same key has finished. */
function inTurn(key, fn) {
  const run = (imageChains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  imageChains.set(key, run);
  const clean = () => {
    if (imageChains.get(key) === run) imageChains.delete(key);
  };
  run.then(clean, clean);
  return run;
}

/** The collectible this request is about, or null after answering (a 404 or a 400). */
async function collectibleOf(req, res) {
  if (!isItemId(req.params.id)) return fail(res, 'Unknown item.', 404) && null;
  const item = await getItem(req.guild.id, Number(req.params.id));
  if (!item) return fail(res, 'Unknown item.', 404) && null;
  if (item.type !== 'collectible') return fail(res, 'Only a collectible has a picture.') && null;
  return item;
}

router.post(
  '/modules/economy/shop/items/:id/image',
  imageUploadLimit,
  asyncHandler(async (req, res) => {
    const guildId = req.guild.id;
    if (!(await collectibleOf(req, res))) return undefined;
    const id = Number(req.params.id);
    let picture;
    try {
      picture = await processImage(await readUpload(req), { owner: guildId });
    } catch (err) {
      if (err instanceof ImageError) return fail(res, err.message, err.status);
      throw err;
    }
    const out = await inTurn(guildId, () =>
      attachImage(guildId, id, { mime: picture.mime, data: picture.data })
    );
    if (!out.ok) {
      if (out.reason === 'quota') {
        return fail(
          res,
          `This server already stores ${out.count} pictures (${Math.ceil(out.bytes / 1024 / 1024)} MB). The most is ${MAX_IMAGES_PER_GUILD} pictures and ${MAX_IMAGE_BYTES_PER_GUILD / 1024 / 1024} MB: remove pictures or items nobody owns to make room.`
        );
      }
      return fail(res, 'Unknown item.', 404);
    }
    await recordAudit(guildId, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `changed the picture of item #${id}`,
    });
    return res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild) });
  })
);

// Taking the picture off an item: only the item lets go of it. The members who own the item keep the picture
// their copy shows, and it is deleted when the last copy lets go.
router.post(
  '/modules/economy/shop/items/:id/image/delete',
  asyncHandler(async (req, res) => {
    const guildId = req.guild.id;
    if (!(await collectibleOf(req, res))) return undefined;
    const id = Number(req.params.id);
    await detachImage(guildId, id);
    await recordAudit(guildId, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `removed the picture of item #${id}`,
    });
    return res.json({ items: await itemsPayload(req.guild), pictures: await picturesPayload(req.guild) });
  })
);

// --- a member's inventory ----------------------------------------------------------------------------------

async function memberOf(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

router.get(
  '/modules/economy/members/:userId/inventory',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.userId)) return fail(res, 'Pick a member.');
    res.json({ inventory: await inventoryPayload(req.guild, req.params.userId) });
  })
);

router.post(
  '/modules/economy/members/:userId/inventory/grant',
  asyncHandler(async (req, res) => {
    const { guild } = req;
    const userId = req.params.userId;
    if (!isId(userId)) return fail(res, 'Pick a member.');
    const { enabled, config } = await economySettings(guild.id);
    if (!enabled) return fail(res, 'Turn the Economy module on first.');
    if (!isItemId(req.body?.itemId)) return fail(res, 'Pick an item.');
    const item = await getItem(guild.id, Number(req.body.itemId));
    if (!item) return fail(res, 'Unknown item.', 404);
    if (roleProblem(req, res, guild, item)) return undefined;
    const member = await memberOf(guild, userId);
    if (!member) return fail(res, shopRefusalText({ reason: 'member_gone' }, config));
    if (member.user?.bot) return fail(res, 'Bots do not have an account.');
    if (!withinPlatformLimit(req, res)) return undefined;

    const out = await grantItem({
      guild,
      member,
      itemId: item.id,
      by: actingUserId(req, guild.id, null),
      reason: normaliseReason(req.body?.reason),
      config,
    });
    if (!out.ok) return fail(res, shopRefusalText(out, config));
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'economy:inventory',
      detail: `gave ${item.name} to ${userId}`,
    });
    res.json({ inventory: await inventoryPayload(guild, userId) });
  })
);

/** Revoke or refund one row: the shared body of the two routes. */
async function endOne(req, res, mode) {
  const { guild } = req;
  const userId = req.params.userId;
  if (!isId(userId) || !isItemId(req.params.rowId)) return fail(res, 'Unknown entry.', 404);
  const { config } = await economySettings(guild.id);
  const row = await getInventoryRow(guild.id, Number(req.params.rowId));
  if (!row || row.userId !== userId) return fail(res, 'Unknown entry.', 404);
  if (!withinPlatformLimit(req, res)) return undefined;
  const out = await endRow({
    guild,
    rowId: row.id,
    mode,
    by: actingUserId(req, guild.id, null),
    reason: normaliseReason(req.body?.reason),
    config,
  });
  if (!out.ok) return fail(res, shopRefusalText(out, config));
  await recordAudit(guild.id, {
    actor: actor(req),
    action: 'economy:inventory',
    detail: `${mode === 'refund' && out.refunded ? 'refunded' : 'revoked'} ${row.itemName} (#${row.id}) of ${userId}`,
  });
  return res.json({
    refunded: out.refunded,
    ...(out.warning ? { warning: out.warning } : {}),
    inventory: await inventoryPayload(guild, userId),
  });
}

router.post(
  '/modules/economy/members/:userId/inventory/:rowId/revoke',
  asyncHandler((req, res) => endOne(req, res, 'revoke'))
);
router.post(
  '/modules/economy/members/:userId/inventory/:rowId/refund',
  asyncHandler((req, res) => endOne(req, res, 'refund'))
);

router.post(
  '/modules/economy/members/:userId/inventory/:rowId/fulfil',
  asyncHandler(async (req, res) => {
    const { guild } = req;
    const userId = req.params.userId;
    if (!isId(userId) || !isItemId(req.params.rowId)) return fail(res, 'Unknown entry.', 404);
    const row = await getInventoryRow(guild.id, Number(req.params.rowId));
    if (!row || row.userId !== userId) return fail(res, 'Unknown entry.', 404);
    // Staff text only: what staff type here, never anything a member wrote.
    const note = normaliseReason(req.body?.note);
    const undo = req.body?.fulfilled === false;
    const done = undo
      ? await markUnfulfilled(guild.id, row.id)
      : await markFulfilled(guild.id, row.id, actingUserId(req, guild.id, null), note);
    if (!done) return fail(res, 'Only an active custom item that is waiting can be marked fulfilled.');
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'economy:inventory',
      detail: `${undo ? 'reopened' : 'fulfilled'} #${row.id} (${row.itemName})`,
    });
    res.json({ inventory: await inventoryPayload(guild, userId) });
  })
);

// --- the activity log --------------------------------------------------------------------------------------------

router.get(
  '/modules/economy/shop/activity',
  asyncHandler(async (req, res) => {
    const { guild } = req;
    const userId = isId(req.query.userId) ? String(req.query.userId) : null;
    const itemId = isItemId(req.query.itemId) ? Number(req.query.itemId) : null;
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const { rows, total } = await listActivity(guild.id, {
      userId,
      itemId,
      purchasesOnly: req.query.all !== '1',
      limit: ACTIVITY_PAGE,
      offset: (page - 1) * ACTIVITY_PAGE,
    });
    const items = new Map((await listItems(guild.id)).map((i) => [i.id, i]));
    res.json({
      page,
      pages: Math.max(1, Math.ceil(total / ACTIVITY_PAGE)),
      total,
      rows: await Promise.all(rows.map((r) => rowView(guild, r, items))),
    });
  })
);

export default router;
