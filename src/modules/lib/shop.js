// The Economy shop: buying, giving, revoking and refunding items, and marking custom items fulfilled.
// Everything that moves money goes through the money API (modules/lib/economy.js) and everything that
// changes stock, the inventory or a temporary-role record happens in the SAME transaction, in the
// `after` hook (a generator, see db/driver.js transaction()):
//
//   purchase   debit the price (`purchase`), take one from the stock, check the member's limit,
//              write the temp-role record for a temporary role, add the inventory row.
//   endRow     refund (`refund`) or revoke (`revoke`): the row's status, the stock, the temp-role
//              record, and the money back, in one transaction.
//   grantItem  a free item (`grant`, amount 0): the inventory row and the temp-role record.
//
// A role is put on the member on the PLATFORM only after the transaction committed (a Discord or
// Fluxer call cannot sit inside a database transaction). A role item's inventory row starts as
// `pending` and becomes `active` once the role is on. If the platform refuses, the same code path
// undoes the purchase: the money goes back through the money API (`refund`), the stock and the
// temp-role record are restored in one transaction, and the buyer is told. A restart between the two
// steps is mopped up by the sweep at the bottom, which refunds rows stuck as `pending`.
//
// Items are the staff's text; nothing a member types ever goes into an item, a ledger reason or a
// fulfilment note.
import { EmbedBuilder } from 'discord.js';
import { abort, transact } from './economy.js';
import { formatMoney } from './economyConfig.js';
import { activateRow, getInventoryRow, getItem, stalePending } from '../../db/economyShop.js';
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
    (guild_id, user_id, item_id, item_name, item_type, role_id, price_paid, source, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

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
 * missing role, Sylo cannot hand out the role, or a permanent role the member already has.
 * @returns {{ reason: string, message?: string } | null}
 */
export function buyProblem(guild, member, item) {
  if (!item) return { reason: 'item_gone' };
  if (!item.enabled) return { reason: 'item_paused' };
  if (item.stock !== null && item.sold >= item.stock) return { reason: 'sold_out' };
  if (!requirementsMet(item, rolesOf(member))) return { reason: 'requirements', roles: item.requiredRoles };
  if (item.type !== 'custom') {
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
    case 'sold_out':
      return 'That item is sold out.';
    case 'price_changed':
      return 'The price just changed. Look at the shop again.';
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
 * For a custom item, a notice goes to the shop channel when one is set.
 * @param {{ guild: any, member: any, itemId: number, config: object, now?: number }} args
 * @returns {Promise<{ ok: true, row: object, item: object, account: object, expiresAt?: number, extended?: boolean }
 *   | { ok: false, reason: string, [k: string]: any }>}
 */
export async function purchase({ guild, member, itemId, config, now = Date.now() }) {
  const guildId = guildKey(guild);
  const userId = member.id;
  const item = await getItem(guildId, itemId);
  const problem = buyProblem(guild, member, item);
  if (problem) return { ok: false, ...problem };

  const box = { rowId: null, previous: null, expiresAt: null, extended: false };
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
        // Stock and price in one conditional update: a buyer who is too late (or saw an old price) changes nothing.
        const took = yield tx.run(
          `UPDATE economy_items SET sold = sold + 1, updated_at = ?
           WHERE guild_id = ? AND id = ? AND price = ? AND enabled = 1 AND (stock IS NULL OR sold < stock)`,
          now,
          guildId,
          item.id,
          item.price
        );
        if (took.changes !== 1) {
          const cur = yield tx.get(
            'SELECT price, enabled FROM economy_items WHERE guild_id = ? AND id = ?',
            guildId,
            item.id
          );
          if (!cur) abort('item_gone');
          if (Number(cur.enabled) !== 1) abort('item_paused');
          if (Number(cur.price) !== item.price) abort('price_changed');
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
        if (item.type === 'temp_role') {
          const existing = yield* readTempRoleRow(tx, guildId, userId, item.roleId);
          if (!existing && (yield* countTempRoleRows(tx, guildId)) >= TEMP_ROLE_CEILING)
            abort('temp_role_limit');
          box.expiresAt = extendedExpiry(existing?.expires_at ?? null, now, item.durationMs);
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
          item.type === 'custom' ? 'active' : 'pending',
          now,
          now
        );
      },
    }
  );
  if (!out.ok) return out;

  const row = await getInventoryRow(guildId, box.rowId);
  const account = out.accounts.get(userId);
  if (item.type === 'custom') {
    await notifyStaff({ guildId, config, item, member, row });
    return { ok: true, row, item, account };
  }
  return finishRoleGrant({ guild, member, item, row, account, box, config, now, refundOnFailure: true });
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
    const undone = await endRow({
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
  await activateRow(guildId, row.id, now);
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
  if (item.type !== 'custom') {
    const role = guild.roles.cache.get(item.roleId) ?? null;
    const refusal = botRefusal(guild, role);
    if (refusal) return { ok: false, reason: 'cannot_grant', message: refusal };
    if (item.type === 'role' && member.roles.cache.has(item.roleId))
      return { ok: false, reason: 'already_has_role' };
  }
  const box = { rowId: null, previous: null, expiresAt: null, extended: false };
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
        if (item.type === 'temp_role') {
          const existing = yield* readTempRoleRow(tx, guildId, userId, item.roleId);
          if (!existing && (yield* countTempRoleRows(tx, guildId)) >= TEMP_ROLE_CEILING)
            abort('temp_role_limit');
          box.expiresAt = extendedExpiry(existing?.expires_at ?? null, now, item.durationMs);
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
          item.type === 'custom' ? 'active' : 'pending',
          now,
          now
        );
      },
    }
  );
  if (!out.ok) return out;
  const row = await getInventoryRow(guildId, box.rowId);
  const account = out.accounts.get(userId);
  if (item.type === 'custom') return { ok: true, row, item, account };
  return finishRoleGrant({ guild, member, item, row, account, box, config, now, refundOnFailure: false });
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
export async function endRow({
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
            const other = yield tx.get(
              `SELECT COUNT(*) AS n FROM economy_inventory
               WHERE guild_id = ? AND user_id = ? AND role_id = ? AND item_type = 'temp_role' AND id <> ? AND status IN ('active', 'pending')`,
              guildId,
              row.userId,
              row.roleId,
              rowId
            );
            if (Number(other.n) === 0) {
              yield* deleteTempRoleRow(tx, guildId, row.userId, row.roleId);
              box.dropRole = true;
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

/** A role item whose role was never confirmed after this long is mopped up. */
export const PENDING_GRACE_MS = 2 * 60_000;

/**
 * Rows still `pending` after the grace time (the process stopped between the commit and the platform
 * call): when the member has the role the row becomes active, otherwise the purchase is refunded.
 * @returns {Promise<number>} how many rows were settled
 */
export async function recoverPending(now = Date.now(), { config } = {}) {
  if (!allClientsReady()) return 0;
  let settled = 0;
  for (const row of await stalePending(now - PENDING_GRACE_MS, 50)) {
    const guild = guildByKey(row.guildId);
    if (!guild) continue;
    try {
      const member =
        guild.members.cache.get(row.userId) ?? (await guild.members.fetch(row.userId).catch(() => null));
      if (member?.roles.cache.has(row.roleId) && row.itemType !== 'custom') {
        await activateRow(row.guildId, row.id, now);
      } else {
        await endRow({
          guild,
          rowId: row.id,
          mode: 'refund',
          reason: 'The role was never confirmed',
          config,
          now,
          platform: false,
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
