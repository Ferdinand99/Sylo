// The Economy shop: buying, giving, revoking and refunding items, and marking custom items fulfilled.
// Everything that moves money goes through the money API (modules/lib/economy.js) and everything that
// changes stock, the inventory or a temporary-role record happens in the SAME transaction, in the
// `after` hook (a generator, see db/driver.js transaction()):
//
//   purchase   debit the price (`purchase`), take one from the stock, check the member's limit,
//              write the temp-role record for a temporary role, add the inventory row. A custom item
//              and a collectible are `active` at once: nothing on the platform has to happen first.
//   endRow     refund (`refund`) or revoke (`revoke`): the row's status, the stock, the temp-role
//              record, and the money back, in one transaction.
//   grantItem  a free item (`grant`, amount 0): the inventory row and the temp-role record.
//
// A role is put on the member on the PLATFORM only after the transaction committed (a Discord or
// Fluxer call cannot sit inside a database transaction). A role item's inventory row starts as
// `pending` and becomes `active` once the role is on. If the platform refuses, the same code path
// undoes the purchase: the money goes back through the money API (`refund`), the stock and the
// temp-role record are restored in one transaction, and the buyer is told. A restart between the two
// steps is mopped up by the sweep at the bottom, which settles rows stuck as `pending` once their
// lease has run out: the role is on, so the row is confirmed; the role is not, so it is refunded.
// A grant that is still running (in this process, or inside its lease) is never touched by the sweep,
// and a refund or revoke of a pending row waits for the grant, so nobody keeps a role after a revoke.
//
// A purchase says which price and which version of the item the member saw (`expectedPrice`,
// `expectedVersion` = the item's `updated_at`, which every staff edit changes and a sale does not): if
// the price is another one now, or the item was changed in any way (role, duration, type, ...), nothing
// is charged and the member is told to look again.
//
// An inventory row of a temporary role remembers how much time it added to the role's record
// (`added_ms`): a refund or revoke takes off only that, so time staff gave by hand stays. When the
// temp-role code drops a record (it ran out, was taken off) the rows become `expired`.
//
// A collectible is an item with a picture (and maybe a rarity) that gives no role: it is bought, owned, shown
// (/collection) and refunded like any other, optionally announced in a channel when it is bought
// (modules/lib/collectibles.js), and a collectible without a picture cannot be bought yet.
//
// Items are the staff's text; nothing a member types ever goes into an item, a ledger reason or a
// fulfilment note.
import { EmbedBuilder } from 'discord.js';
import { abort, transact } from './economy.js';
import { formatMoney, isRoleItemType } from './economyConfig.js';
import { announcePurchase } from './collectibles.js';
import { releaseImageTx } from '../../db/collectibleImages.js';
import {
  activateRow,
  deferPendingLease,
  getInventoryRow,
  getItem,
  liveRoleRows,
  liveRowsForRole,
  stalePending,
} from '../../db/economyShop.js';
import { isNotFound } from '../../platform/messageErrors.js';
import {
  TEMP_ROLE_CEILING,
  announceShopTempRole,
  botRefusal,
  countTempRoleRows,
  deleteTempRoleRow,
  extendedExpiry,
  giveRoleOnPlatform,
  readTempRoleRow,
  takeRoleOnPlatform,
  writeTempRoleRow,
} from '../tempRoles.js';
import { allClientsReady, guildByKey, guildKey } from '../../platform/platformOf.js';
import { sendToChannel } from './send.js';
import { log } from '../../lib/log.js';
import { every } from '../schedule.js';

const INSERT_ROW = `
  INSERT INTO economy_inventory
    (guild_id, user_id, item_id, item_name, item_type, role_id, price_paid, source, status, added_ms, lease_until, created_at, updated_at, image_id, rarity)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Inside a transaction: the picture and rarity a new copy of a collectible carries, read from the item as it is
 * NOW. The item row is locked first (a no-op update, the lock a replaced picture also takes), so a picture
 * that is replaced at the same moment either comes before this copy, which then carries the new one, or after
 * it, and then its update moves this copy to the new picture too. `needPicture` (a purchase) refuses an item
 * whose picture was taken off in the meantime. Anything that is not a collectible carries none.
 */
function* pictureOfCopy(tx, guildId, item, { needPicture }) {
  if (item.type !== 'collectible') return { imageId: null, rarity: null };
  yield tx.run('UPDATE economy_items SET sold = sold WHERE guild_id = ? AND id = ?', guildId, item.id);
  const cur = yield tx.get(
    'SELECT image_id, rarity FROM economy_items WHERE guild_id = ? AND id = ?',
    guildId,
    item.id
  );
  if (!cur) abort('item_gone');
  if (needPicture && !cur.image_id) abort('no_image');
  return { imageId: cur.image_id ?? null, rarity: cur.rarity ?? null };
}

/** A role grant that is not confirmed within this long after its purchase is mopped up by the sweep. */
export const GRANT_LEASE_MS = 5 * 60_000;
/** A refund or revoke waits at most this long for the grant of the same row that is running. */
const GRANT_WAIT_MS = 30_000;

// Role grants running in this process, by inventory row id: the sweep skips them, and a refund,
// revoke or /forget of the same row waits for them.
const inflight = new Map();

/** Run a role grant as "in flight" for its row. */
async function trackGrant(rowId, run) {
  let done;
  inflight.set(
    rowId,
    new Promise((resolve) => {
      done = resolve;
    })
  );
  try {
    return await run();
  } finally {
    inflight.delete(rowId);
    done();
  }
}

/** Wait for the grant of a row that is running, for a limited time. */
async function waitForGrant(rowId) {
  const running = inflight.get(rowId);
  if (!running) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, GRANT_WAIT_MS);
    timer.unref?.();
  });
  await Promise.race([running, timeout]);
  clearTimeout(timer);
}

/** True when the member holds one of the item's required roles (or it has none). */
export function requirementsMet(item, roleIds) {
  if (!item.requiredRoles.length) return true;
  const have = new Set(roleIds);
  return item.requiredRoles.some((id) => have.has(id));
}

/** The member's role ids, from a platform member object. */
const rolesOf = (member) => [...(member?.roles?.cache?.keys?.() ?? [])];

/**
 * The reasons a member cannot buy an item right now, before any money is asked: gone, paused, sold out,
 * missing role, a collectible that has no picture yet, Sylo cannot hand out the role, or a permanent role
 * the member already has.
 * @returns {{ reason: string, message?: string } | null}
 */
export function buyProblem(guild, member, item) {
  if (!item) return { reason: 'item_gone' };
  if (!item.enabled) return { reason: 'item_paused' };
  if (item.stock !== null && item.sold >= item.stock) return { reason: 'sold_out' };
  if (!requirementsMet(item, rolesOf(member))) return { reason: 'requirements', roles: item.requiredRoles };
  if (item.type === 'collectible' && !item.imageId) return { reason: 'no_image' };
  if (isRoleItemType(item.type)) {
    const role = guild.roles.cache.get(item.roleId) ?? null;
    const refusal = botRefusal(guild, role);
    if (refusal) return { reason: 'cannot_grant', message: refusal };
    if (item.type === 'role' && member.roles.cache.has(item.roleId)) return { reason: 'already_has_role' };
  }
  return null;
}

/**
 * Find the item a member typed: its exact name, else its number in /shop (the position among the
 * items for sale), else a name that contains the text when only one does.
 * @param {object[]} items  the items for sale, in shop order
 * @param {string} text
 * @returns {{ item: object | null, ambiguous?: object[] }}
 */
export function pickItem(items, text) {
  const t = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!t) return { item: null };
  const exact = items.find((i) => i.name.toLowerCase() === t);
  if (exact) return { item: exact };
  if (/^\d{1,6}$/.test(t)) return { item: items[Number(t) - 1] ?? null };
  const partial = items.filter((i) => i.name.toLowerCase().includes(t));
  if (partial.length === 1) return { item: partial[0] };
  return { item: null, ...(partial.length > 1 ? { ambiguous: partial.slice(0, 5) } : {}) };
}

/** An inventory row's name with its emoji-free label (the name it had when it was bought). */
export const itemLabelOfRow = (row) => row.itemName;

/** The item's name with its emoji, for a line of text. */
export const itemLabel = (item) => `${item.emoji ? `${item.emoji} ` : ''}${item.name}`;

/** A sentence for a refusal of any shop call. `config` formats amounts. */
export function shopRefusalText(result, config) {
  switch (result.reason) {
    case 'item_gone':
      return 'That item is no longer in the shop.';
    case 'item_paused':
      return 'That item is not for sale right now.';
    case 'no_image':
      return 'That item is not ready yet: staff have not added its picture.';
    case 'sold_out':
      return 'That item is sold out.';
    case 'item_changed':
      return 'This item changed, check it and try again.';
    case 'price_changed':
      return result.price != null
        ? `The price changed to ${formatMoney(result.price, config)}. Check and try again.`
        : 'The price changed. Check and try again.';
    case 'limit':
      return 'You already have as many of that item as you may buy.';
    case 'requirements':
      return `You need one of these roles to buy that: ${(result.roles ?? []).map((id) => `<@&${id}>`).join(', ')}.`;
    case 'cannot_grant':
      return `${result.message ?? 'Sylo cannot hand out that role.'} Nothing was charged.`;
    case 'already_has_role':
      return 'You already have that role.';
    case 'temp_role_limit':
      return 'This server has reached its limit of temporary roles. Ask staff.';
    case 'insufficient':
      return result.needed
        ? `You do not have enough cash: it costs ${formatMoney(result.needed, config)}.`
        : 'You do not have enough cash for that.';
    case 'grant_failed':
      return `${result.message ?? 'Sylo could not give you the role.'} ${
        result.refunded ? 'You got your money back.' : 'Ask staff about your payment.'
      }`;
    case 'not_active':
      return 'That item is no longer active.';
    case 'grant_ended':
      return 'That purchase was ended before the role arrived. Ask staff if you paid.';
    case 'not_found':
      return 'There is no such inventory entry.';
    case 'member_gone':
      return 'That person is not in this server.';
    default:
      return 'That did not work.';
  }
}

// --- buying ------------------------------------------------------------------------------------------------

/**
 * Buy one item for a member.
 *
 * Checked before any money moves: the item exists, is for sale, is not sold out, the member has a
 * required role, Sylo can hand out the role. Then ONE transaction: the debit (`purchase`), the stock
 * (one more `sold`, only while stock is left and the price is still the price the member saw), the
 * per-member limit, the temp-role record and the inventory row. 20 buyers of the last 5 items get
 * exactly 5. Buying a temporary role again while it runs ADDS the new time to what is left.
 *
 * Then, for a role item, the role goes on in the platform; if that fails the purchase is refunded.
 * For a custom item, a notice goes to the shop channel when one is set. A collectible is the member's at
 * once; when the item announces its purchases and a channel is set, the purchase is announced there.
 * `expectedPrice` and `expectedVersion` (the item's `updatedAt`) are what the member saw (the
 * confirmation, the web page). When the item costs something else now: `price_changed` with the
 * current price; when it was changed in any other way: `item_changed`. Nothing is charged either way.
 * @param {{ guild: any, member: any, itemId: number, expectedPrice: number, expectedVersion: number, config: object, now?: number }} args
 * @returns {Promise<{ ok: true, row: object, item: object, account: object, expiresAt?: number, extended?: boolean }
 *   | { ok: false, reason: string, [k: string]: any }>}
 */
export async function purchase({
  guild,
  member,
  itemId,
  expectedPrice,
  expectedVersion,
  config,
  now = Date.now(),
}) {
  const guildId = guildKey(guild);
  const userId = member.id;
  const item = await getItem(guildId, itemId);
  const problem = buyProblem(guild, member, item);
  if (problem) return { ok: false, ...problem };
  // The member agreed to a price: never charge another one.
  if (item.price !== expectedPrice) return { ok: false, reason: 'price_changed', price: item.price };
  if (item.updatedAt !== expectedVersion) return { ok: false, reason: 'item_changed' };

  const box = { rowId: null, previous: null, expiresAt: null, extended: false, added: 0 };
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      if (acc.cash < item.price)
        return { refuse: { reason: 'insufficient', needed: item.price, account: acc } };
      return {
        changes: [{ userId, cash: -item.price, kind: 'purchase', reason: itemLabel(item).slice(0, 200) }],
      };
    },
    {
      now,
      config,
      after: function* (tx) {
        // Stock, price and version in one conditional update: a buyer who is too late (or saw an old
        // item) changes nothing. A sale does not touch updated_at: it is the version staff edits change.
        const took = yield tx.run(
          `UPDATE economy_items SET sold = sold + 1
           WHERE guild_id = ? AND id = ? AND price = ? AND updated_at = ? AND enabled = 1
             AND (stock IS NULL OR sold < stock)`,
          guildId,
          item.id,
          item.price,
          item.updatedAt
        );
        if (took.changes !== 1) {
          const cur = yield tx.get(
            'SELECT price, enabled, updated_at FROM economy_items WHERE guild_id = ? AND id = ?',
            guildId,
            item.id
          );
          if (!cur) abort('item_gone');
          if (Number(cur.enabled) !== 1) abort('item_paused');
          if (Number(cur.price) !== item.price) abort('price_changed', { price: Number(cur.price) });
          if (Number(cur.updated_at) !== item.updatedAt) abort('item_changed');
          abort('sold_out');
        }
        if (item.perMemberLimit !== null) {
          const have = yield tx.get(
            `SELECT COUNT(*) AS n FROM economy_inventory
             WHERE guild_id = ? AND user_id = ? AND item_id = ? AND source = 'purchase' AND status IN ('active', 'pending')`,
            guildId,
            userId,
            item.id
          );
          if (Number(have.n) >= item.perMemberLimit) abort('limit');
        }
        // A permanent role is bought once: two buys at the same moment both passed the check before
        // the transaction, and the member's account lock makes them take turns here, so the second
        // sees the first one's row and is refused (and so is not charged).
        if (item.type === 'role') yield* refuseIfRoleHeld(tx, guildId, userId, item.roleId);
        if (item.type === 'temp_role') {
          const existing = yield* readTempRoleRow(tx, guildId, userId, item.roleId);
          if (!existing && (yield* countTempRoleRows(tx, guildId)) >= TEMP_ROLE_CEILING)
            abort('temp_role_limit');
          box.expiresAt = extendedExpiry(existing?.expires_at ?? null, now, item.durationMs);
          box.added = Math.max(
            0,
            box.expiresAt - (existing && existing.expires_at > now ? existing.expires_at : now)
          );
          box.extended = Boolean(existing && existing.expires_at > now);
          box.previous = existing
            ? {
                expiresAt: existing.expires_at,
                addedBy: existing.added_by,
                reason: existing.reason,
                createdAt: existing.created_at,
              }
            : null;
          yield* writeTempRoleRow(tx, {
            guildId,
            userId,
            roleId: item.roleId,
            expiresAt: box.expiresAt,
            addedBy: null,
            reason: `Shop: ${item.name}`,
            createdAt: now,
          });
        }
        const picture = yield* pictureOfCopy(tx, guildId, item, { needPicture: true });
        box.rowId = yield tx.insertId(
          INSERT_ROW,
          guildId,
          userId,
          item.id,
          item.name,
          item.type,
          item.roleId,
          item.price,
          'purchase',
          isRoleItemType(item.type) ? 'pending' : 'active',
          box.added,
          now + GRANT_LEASE_MS,
          now,
          now,
          picture.imageId,
          picture.rarity
        );
      },
    }
  );
  if (!out.ok) return out;

  const account = out.accounts.get(userId);
  if (!isRoleItemType(item.type)) {
    const row = await getInventoryRow(guildId, box.rowId);
    if (item.type === 'custom') await notifyStaff({ guildId, config, item, member, row });
    else await announcePurchase({ guildId, config, item, userId });
    return { ok: true, row, item, account };
  }
  return trackGrant(box.rowId, async () => {
    const row = await getInventoryRow(guildId, box.rowId);
    return finishRoleGrant({ guild, member, item, row, account, box, config, now, refundOnFailure: true });
  });
}

/** Inside a transaction: refuse (`already_has_role`) when the member holds a permanent role item for this role. */
function* refuseIfRoleHeld(tx, guildId, userId, roleId) {
  const held = yield tx.get(
    `SELECT COUNT(*) AS n FROM economy_inventory
     WHERE guild_id = ? AND user_id = ? AND role_id = ? AND item_type = 'role' AND status IN ('active', 'pending')`,
    guildId,
    userId,
    roleId
  );
  if (Number(held.n) > 0) abort('already_has_role');
}

/**
 * Put the role of a just-written row on the member and make the row active, or undo the row when the
 * platform refuses (a refund for a purchase, a revoke for a free grant).
 */
async function finishRoleGrant({ guild, member, item, row, account, box, config, now, refundOnFailure }) {
  const guildId = guildKey(guild);
  const role = guild.roles.cache.get(item.roleId) ?? null;
  const problem = role
    ? await giveRoleOnPlatform(guild, member, role, `Shop: ${item.name}`)
    : 'That role no longer exists.';
  if (problem) {
    const undone = await endRowNow({
      guild,
      rowId: row.id,
      mode: refundOnFailure ? 'refund' : 'revoke',
      reason: 'The role could not be given',
      restoreTemp: item.type === 'temp_role' ? box.previous : undefined,
      config,
      now,
      platform: false,
    });
    return {
      ok: false,
      reason: 'grant_failed',
      message: problem,
      refunded: Boolean(undone.ok && undone.refunded),
      account: undone.account ?? account,
    };
  }
  // The row may have been ended while the role was on its way (a revoke or a refund of a pending
  // row, or the sweep): then the role must not stay on the member.
  if (!(await activateRow(guildId, row.id, now))) {
    if ((await liveRowsForRole(guildId, row.userId, item.roleId, row.id)) === 0) {
      await takeRoleOnPlatform(guild, row.userId, item.roleId, 'Shop: the purchase was ended');
    }
    return { ok: false, reason: 'grant_ended', account };
  }
  if (item.type === 'temp_role') {
    await announceShopTempRole({
      guild,
      member,
      role,
      expiresAt: box.expiresAt,
      extended: box.extended,
    }).catch(() => {});
  }
  return {
    ok: true,
    row: { ...row, status: 'active' },
    item,
    account,
    ...(item.type === 'temp_role' ? { expiresAt: box.expiresAt, extended: box.extended } : {}),
  };
}

/** Post "X bought Y: fulfil it" in the shop channel, if one is set. Staff text and a mention only. */
async function notifyStaff({ guildId, config, item, member, row }) {
  if (!config.shopChannelId) return false;
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('Shop: an item to fulfil')
    .setDescription(
      `<@${member.id}> ${row.source === 'grant' ? 'was given' : 'bought'} **${itemLabel(item)}**. Fulfil it, then mark it fulfilled in the dashboard (Economy, Members, Inventory).`
    )
    .addFields({ name: 'Entry', value: `#${row.id}`, inline: true })
    .setTimestamp(Date.now());
  return sendToChannel(guildId, config.shopChannelId, { embeds: [embed], allowedMentions: { parse: [] } });
}

// --- free grants -----------------------------------------------------------------------------------------

/**
 * Give a member an item for free (staff). No price, no stock, no requirements, no limit; a paused item
 * can still be given. The ledger gets a `grant` row of amount 0. A role is put on the member
 * afterwards; if that fails the grant is undone (a `revoke` row).
 */
export async function grantItem({ guild, member, itemId, by = null, reason = '', config, now = Date.now() }) {
  if (!member) return { ok: false, reason: 'member_gone' };
  const guildId = guildKey(guild);
  const userId = member.id;
  const item = await getItem(guildId, itemId);
  if (!item) return { ok: false, reason: 'item_gone' };
  if (isRoleItemType(item.type)) {
    const role = guild.roles.cache.get(item.roleId) ?? null;
    const refusal = botRefusal(guild, role);
    if (refusal) return { ok: false, reason: 'cannot_grant', message: refusal };
    if (item.type === 'role' && member.roles.cache.has(item.roleId))
      return { ok: false, reason: 'already_has_role' };
  }
  const box = { rowId: null, previous: null, expiresAt: null, extended: false, added: 0 };
  const out = await transact(
    guildId,
    [userId],
    () => ({
      changes: [
        {
          userId,
          cash: 0,
          kind: 'grant',
          record: true,
          actorId: by,
          reason: String(reason || itemLabel(item)).slice(0, 200),
        },
      ],
    }),
    {
      now,
      config,
      after: function* (tx) {
        if (item.type === 'role') yield* refuseIfRoleHeld(tx, guildId, userId, item.roleId);
        if (item.type === 'temp_role') {
          const existing = yield* readTempRoleRow(tx, guildId, userId, item.roleId);
          if (!existing && (yield* countTempRoleRows(tx, guildId)) >= TEMP_ROLE_CEILING)
            abort('temp_role_limit');
          box.expiresAt = extendedExpiry(existing?.expires_at ?? null, now, item.durationMs);
          box.added = Math.max(
            0,
            box.expiresAt - (existing && existing.expires_at > now ? existing.expires_at : now)
          );
          box.extended = Boolean(existing && existing.expires_at > now);
          box.previous = existing
            ? {
                expiresAt: existing.expires_at,
                addedBy: existing.added_by,
                reason: existing.reason,
                createdAt: existing.created_at,
              }
            : null;
          yield* writeTempRoleRow(tx, {
            guildId,
            userId,
            roleId: item.roleId,
            expiresAt: box.expiresAt,
            addedBy: by,
            reason: `Shop grant: ${item.name}`,
            createdAt: now,
          });
        }
        const picture = yield* pictureOfCopy(tx, guildId, item, { needPicture: false });
        box.rowId = yield tx.insertId(
          INSERT_ROW,
          guildId,
          userId,
          item.id,
          item.name,
          item.type,
          item.roleId,
          0,
          'grant',
          isRoleItemType(item.type) ? 'pending' : 'active',
          box.added,
          now + GRANT_LEASE_MS,
          now,
          now,
          picture.imageId,
          picture.rarity
        );
      },
    }
  );
  if (!out.ok) return out;
  const account = out.accounts.get(userId);
  if (!isRoleItemType(item.type)) {
    return { ok: true, row: await getInventoryRow(guildId, box.rowId), item, account };
  }
  return trackGrant(box.rowId, async () => {
    const row = await getInventoryRow(guildId, box.rowId);
    return finishRoleGrant({ guild, member, item, row, account, box, config, now, refundOnFailure: false });
  });
}

// --- refund and revoke -------------------------------------------------------------------------------------

/**
 * End an inventory row: `refund` gives the price back (a ledger `refund` row, the stock returns, the
 * row becomes `refunded`) and `revoke` takes the item away without money (a `revoke` row of amount 0,
 * the row becomes `revoked`). A refund of a free grant is a revoke. Either way the item stops: its
 * temp-role record goes (unless the member holds the same role from another entry), and then the role
 * comes off on the platform.
 *
 * `restoreTemp` is for undoing a grant that just failed: the temp-role record goes back to exactly what
 * it was (`null` deletes it) and nothing is taken off the platform. `platform: false` skips the
 * platform step (the caller knows the role was never given).
 * @returns {Promise<{ ok: true, row: object, refunded: boolean, account: object, warning?: string } | { ok: false, reason: string }>}
 */
export async function endRow(args) {
  // A grant that is running for this row finishes first, so the role it puts on can be taken off.
  await waitForGrant(args.rowId);
  return endRowNow(args);
}

async function endRowNow({
  guild,
  rowId,
  mode,
  by = null,
  reason = '',
  restoreTemp,
  config,
  now = Date.now(),
  platform = true,
}) {
  const guildId = guildKey(guild);
  const row = await getInventoryRow(guildId, rowId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active' && row.status !== 'pending') return { ok: false, reason: 'not_active' };
  const refundable = mode === 'refund' && row.source === 'purchase' && row.pricePaid > 0;
  const text = String(reason || `${row.itemName}`).slice(0, 200);
  const box = { dropRole: false };

  const out = await transact(
    guildId,
    [row.userId],
    () => ({
      changes: [
        refundable
          ? {
              userId: row.userId,
              cash: row.pricePaid,
              kind: 'refund',
              clamp: true,
              record: true,
              actorId: by,
              reason: text,
            }
          : { userId: row.userId, cash: 0, kind: 'revoke', record: true, actorId: by, reason: text },
      ],
    }),
    {
      now,
      config,
      after: function* (tx) {
        const ended = yield tx.run(
          `UPDATE economy_inventory SET status = ?, updated_at = ?
           WHERE guild_id = ? AND id = ? AND status IN ('active', 'pending')`,
          refundable ? 'refunded' : 'revoked',
          now,
          guildId,
          rowId
        );
        if (ended.changes !== 1) abort('not_active');
        // A collectible copy that was the last one holding its picture takes the picture with it.
        if (row.itemType === 'collectible') {
          const held = yield tx.get(
            'SELECT image_id FROM economy_inventory WHERE guild_id = ? AND id = ?',
            guildId,
            rowId
          );
          yield* releaseImageTx(tx, guildId, held?.image_id ?? null);
        }
        if (refundable) {
          // The item may be gone already (deleted): then there is no stock to give back.
          yield tx.run(
            'UPDATE economy_items SET sold = sold - 1 WHERE guild_id = ? AND id = ? AND sold > 0',
            guildId,
            row.itemId
          );
        }
        if (row.itemType === 'temp_role' && row.roleId) {
          if (restoreTemp !== undefined) {
            if (restoreTemp === null) yield* deleteTempRoleRow(tx, guildId, row.userId, row.roleId);
            else {
              yield* writeTempRoleRow(tx, {
                guildId,
                userId: row.userId,
                roleId: row.roleId,
                expiresAt: restoreTemp.expiresAt,
                addedBy: restoreTemp.addedBy,
                reason: restoreTemp.reason,
                createdAt: restoreTemp.createdAt,
              });
            }
          } else {
            // Take off the time this row added, never more (time staff gave by hand stays) and never
            // past now. When nothing is left the record goes and the role comes off.
            // added_ms = -1 means the time the purchase added is unknown (it predates the column): the whole
            // record ends. 0 is a real value (a purchase capped at 365 days added nothing): nothing comes off.
            const rec = yield* readTempRoleRow(tx, guildId, row.userId, row.roleId);
            const left = rec ? rec.expires_at - row.addedMs : 0;
            if (!rec || row.addedMs < 0 || left <= now) {
              if (rec) yield* deleteTempRoleRow(tx, guildId, row.userId, row.roleId);
              box.dropRole = true;
            } else {
              yield* writeTempRoleRow(tx, {
                guildId,
                userId: row.userId,
                roleId: row.roleId,
                expiresAt: left,
                addedBy: rec.added_by,
                reason: rec.reason,
                createdAt: rec.created_at,
              });
            }
          }
        } else if (row.itemType === 'role' && row.roleId) {
          const other = yield tx.get(
            `SELECT COUNT(*) AS n FROM economy_inventory
             WHERE guild_id = ? AND user_id = ? AND role_id = ? AND item_type = 'role' AND id <> ? AND status IN ('active', 'pending')`,
            guildId,
            row.userId,
            row.roleId,
            rowId
          );
          box.dropRole = Number(other.n) === 0;
        }
      },
    }
  );
  if (!out.ok) return out;

  let warning;
  if (platform && box.dropRole) {
    const taken = await takeRoleOnPlatform(
      guild,
      row.userId,
      row.roleId,
      `Shop: ${row.itemName} ${mode === 'refund' ? 'refunded' : 'revoked'}`
    );
    warning = taken.warning;
  }
  return {
    ok: true,
    row: { ...row, status: refundable ? 'refunded' : 'revoked' },
    refunded: refundable,
    account: out.accounts.get(row.userId),
    ...(warning ? { warning } : {}),
  };
}

// --- recovery ------------------------------------------------------------------------------------------------

/**
 * Rows still `pending` when their lease has run out (the process stopped between the commit and the
 * platform call, or the grant never came back). A row whose grant is still running here is left alone.
 * Before anything is refunded the member is looked at: with the role on, the row is confirmed; a
 * member who cannot be looked up right now (a hiccup, not "gone") is tried again next time; a member
 * who is gone or lacks the role gets the purchase refunded (and a role that is still on comes off).
 * A row that is skipped (a grant still running, a platform that is not connected, a lookup that failed)
 * gets its lease pushed forward, so it does not sit at the front of the batch and hide the rows behind it.
 * @param {number} [now]
 * @param {{ config?: object, limit?: number }} [opts]  `limit`: rows looked at per call (default 50)
 * @returns {Promise<number>} how many rows were settled
 */
export async function recoverPending(now = Date.now(), { config, limit = 50 } = {}) {
  if (!allClientsReady()) return 0;
  let settled = 0;
  const later = (row) => deferPendingLease(row.guildId, row.id, now + GRANT_LEASE_MS);
  for (const row of await stalePending(now, limit)) {
    if (inflight.has(row.id)) {
      await later(row);
      continue;
    }
    const guild = guildByKey(row.guildId);
    if (!guild) {
      await later(row);
      continue;
    }
    try {
      let member = guild.members.cache.get(row.userId) ?? null;
      if (!member) {
        try {
          member = await guild.members.fetch(row.userId);
        } catch (err) {
          if (!isNotFound(err, [10007])) {
            await later(row); // not known to be gone: try again later
            continue;
          }
          member = null;
        }
      }
      if (member && isRoleItemType(row.itemType) && member.roles.cache.has(row.roleId)) {
        await activateRow(row.guildId, row.id, now);
      } else {
        await endRow({
          guild,
          rowId: row.id,
          mode: 'refund',
          reason: 'The role was never confirmed',
          config,
          now,
        });
      }
      settled += 1;
    } catch (err) {
      log.error('shop', `could not settle entry ${row.id}:`, err.message);
    }
  }
  return settled;
}

every('economy', 60_000, () => recoverPending());

// --- /forget ------------------------------------------------------------------------------------------------

/**
 * /forget: before the member's records are deleted, the roles the shop gave them come off (a bought
 * temporary role would otherwise outlive its record and stay for good). Waits for a grant that is
 * running. A role Sylo cannot take off is reported in `failed`; for a temporary one the caller keeps
 * its record so the expiry sweep still takes the role back.
 * @returns {Promise<{ roles: number, removed: number, failed: string[] }>}
 */
export async function endShopRolesForForget(guild, userId) {
  const guildId = guildKey(guild);
  const rows = await liveRoleRows(guildId, userId);
  for (const r of rows) await waitForGrant(r.id);
  const roles = [...new Set(rows.map((r) => r.roleId))];
  let removed = 0;
  const failed = [];
  for (const roleId of roles) {
    const out = await takeRoleOnPlatform(guild, userId, roleId, 'Shop: the member erased their data');
    if (out.roleRemoved) removed += 1;
    if (out.warning) failed.push(roleId);
  }
  return { roles: roles.length, removed, failed };
}
