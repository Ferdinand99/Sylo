// The Economy shop: the purchase transaction (debit, stock, limit, inventory, ledger), stock races,
// requirements, temporary-role extension, a refund when the platform refuses the role, free grants,
// revoke, refund and fulfilment, a deleted item, and the sweep for purchases stuck half way.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import {
  createItem,
  deleteItem,
  getInventoryRow,
  getItem,
  listActivity,
  listInventory,
  markFulfilled,
  updateItem,
} from '../src/db/economyShop.js';
import { getTempRole, putTempRole } from '../src/db/tempRoles.js';
import { sweep as tempRoleSweep } from '../src/modules/tempRoles.js';
import { abort, credit, transact } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem } from '../src/modules/lib/economyConfig.js';
import {
  endRow,
  endShopRolesForForget,
  grantItem,
  pickItem,
  purchase,
  recoverPending,
  shopRefusalText,
} from '../src/modules/lib/shop.js';
import {
  dropFakeShop,
  fakeMember,
  fakeRole,
  fakeShopGuild,
  ROLE_A,
  ROLE_B,
  ROLE_REQ,
  SHOP_CH,
} from './helpers/fakeShop.js';

let n = 0;
let G;
let ctx;
const cfg = (over = {}) => normaliseEconomyConfig({ shopChannelId: SHOP_CH, ...over });
const U = (i) => `8800000000000${String(i).padStart(5, '0')}`;
const roleA = fakeRole(ROLE_A, 'Millionaire');
const roleB = fakeRole(ROLE_B, 'Legend');
const reqRole = fakeRole(ROLE_REQ, 'Member');
const HOUR = 3_600_000;

beforeEach(() => {
  G = `5700000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G, { roles: [roleA, roleB, reqRole] });
});
afterEach(() => dropFakeShop());

/** A member of the fake server with `cash`, and the guild. */
async function buyer(i, cash = 1000, roles = []) {
  const member = fakeMember(U(i), { roles });
  ctx.guild.members.cache.set(member.id, member);
  if (cash > 0) await credit(G, member.id, cash, { kind: 'staff_add', config: cfg() });
  return member;
}
const item = (over = {}) =>
  createItem(G, normaliseItem({ name: 'Shout-out', price: 100, type: 'custom', ...over }));
// By default the buyer saw the price the item has now; a test of the price check passes `expectedPrice`.
const buy = async (member, itemId, over = {}) =>
  purchase({
    guild: ctx.guild,
    member,
    itemId,
    expectedPrice: (await getItem(G, itemId))?.price,
    config: cfg(),
    ...over,
  });
const cash = async (m) => Number((await getAccount(G, m.id))?.cash ?? 0);
const ledger = (m) =>
  db
    .prepare(
      'SELECT kind, amount, cash_after, reason FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id'
    )
    .all(G, m.id);

test('buying a custom item debits the price, takes one from the stock, adds an inventory row and posts to staff', async () => {
  const m = await buyer(1);
  const id = await item({ stock: 3, description: 'A shout-out on stream' });
  const out = await buy(m, id);
  assert.equal(out.ok, true);
  assert.equal(await cash(m), 900);
  assert.equal((await getItem(G, id)).sold, 1);
  const rows = await listInventory(G, m.id);
  assert.deepEqual(
    [rows.length, rows[0].itemName, rows[0].status, rows[0].source, rows[0].pricePaid],
    [1, 'Shout-out', 'active', 'purchase', 100]
  );
  assert.deepEqual(ledger(m).at(-1), {
    kind: 'purchase',
    amount: -100,
    cash_after: 900,
    reason: 'Shout-out',
  });
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].embeds[0].data.description, new RegExp(`<@${m.id}> bought \\*\\*Shout-out\\*\\*`));
  assert.deepEqual(ctx.sent[0].allowedMentions, { parse: [] });
});

test('a refused purchase changes nothing: sold out, paused, missing role, too poor, gone, a price that changed', async () => {
  const m = await buyer(2, 150);
  const soldOut = await item({ stock: 0 });
  assert.equal((await buy(m, soldOut)).reason, 'sold_out');
  const paused = await item({ enabled: false });
  assert.equal((await buy(m, paused)).reason, 'item_paused');
  const gated = await item({ requiredRoles: [ROLE_REQ] });
  const denied = await buy(m, gated);
  assert.deepEqual([denied.reason, denied.roles], ['requirements', [ROLE_REQ]]);
  const dear = await item({ price: 151 });
  const poor = await buy(m, dear);
  assert.deepEqual([poor.reason, poor.needed], ['insufficient', 151]);
  assert.equal((await buy(m, 999999)).reason, 'item_gone');
  assert.equal(await cash(m), 150);
  assert.equal(ledger(m).length, 1, 'only the starting credit');
  assert.equal(ctx.sent.length, 0);
  for (const id of [soldOut, paused, gated, dear]) assert.equal((await getItem(G, id)).sold, 0);
});

test('a member with a required role may buy; any one of several is enough', async () => {
  const m = await buyer(3, 500, [reqRole]);
  const id = await item({ requiredRoles: [ROLE_B, ROLE_REQ] });
  assert.equal((await buy(m, id)).ok, true);
});

test('a price that changes after the member looked is refused inside the transaction, and nothing is charged', async () => {
  const m = await buyer(4, 500);
  const id = await item({ price: 100 });
  const seen = await getItem(G, id);
  // The page showed 100. Staff change the price before the buy reaches the transaction: the buy was
  // started with the old item, so the conditional update of the stock (it also checks the price) fails.
  await updateItem(G, id, normaliseItem({ name: 'Shout-out', price: 120, type: 'custom' }));
  const out = await transact(
    G,
    [m.id],
    () => ({ changes: [{ userId: m.id, cash: -seen.price, kind: 'purchase' }] }),
    {
      config: cfg(),
      after: function* (tx) {
        const took = yield tx.run(
          'UPDATE economy_items SET sold = sold + 1 WHERE guild_id = ? AND id = ? AND price = ?',
          G,
          id,
          seen.price
        );
        if (took.changes !== 1) abort('price_changed');
      },
    }
  );
  assert.deepEqual([out.ok, out.reason], [false, 'price_changed']);
  assert.equal(await cash(m), 500);
  // and a buy that reads the item afresh pays the new price
  assert.equal((await buy(m, id)).ok, true);
  assert.equal(await cash(m), 380);
});

test('the per-member limit counts purchases that are still held', async () => {
  const m = await buyer(5, 1000);
  const id = await item({ perMemberLimit: 2 });
  assert.equal((await buy(m, id)).ok, true);
  assert.equal((await buy(m, id)).ok, true);
  const third = await buy(m, id);
  assert.equal(third.reason, 'limit');
  assert.equal(await cash(m), 800);
  assert.equal((await getItem(G, id)).sold, 2);
  // a refund frees one
  const rows = await listInventory(G, m.id);
  await endRow({ guild: ctx.guild, rowId: rows[0].id, mode: 'refund', config: cfg() });
  assert.equal((await buy(m, id)).ok, true);
});

test('20 parallel buys of the last 5 items sell exactly 5, and only the winners pay', async () => {
  const id = await item({ stock: 5, price: 10 });
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await buyer(100 + i, 10));
  const results = await Promise.all(members.map((m) => buy(m, id)));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 5);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'sold_out'));
  assert.equal((await getItem(G, id)).sold, 5);
  const rows = db
    .prepare(
      "SELECT COUNT(*) AS c FROM economy_inventory WHERE guild_id = ? AND item_id = ? AND status = 'active'"
    )
    .get(G, id).c;
  assert.equal(rows, 5);
  let paid = 0;
  for (const m of members) paid += 10 - (await cash(m));
  assert.equal(paid, 50, 'exactly 5 x 10 was taken');
});

test('one member buying the last item twice at once gets it once', async () => {
  const m = await buyer(6, 1000);
  const id = await item({ stock: 1, price: 100 });
  const results = await Promise.all([buy(m, id), buy(m, id), buy(m, id)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await cash(m), 900);
});

// --- roles ---------------------------------------------------------------------------------------------

test('a permanent role is put on the member, the row becomes active, and it cannot be bought twice', async () => {
  const m = await buyer(7);
  const id = await item({ name: 'Legend', type: 'role', roleId: ROLE_B, price: 300 });
  const out = await buy(m, id);
  assert.equal(out.ok, true);
  assert.deepEqual(m.adds, [ROLE_B]);
  assert.equal((await listInventory(G, m.id))[0].status, 'active');
  const again = await buy(m, id);
  assert.equal(again.reason, 'already_has_role');
  assert.equal(await cash(m), 700);
});

test('if Sylo cannot hand out the role, nothing is charged', async () => {
  ctx = fakeShopGuild(G, { roles: [roleA, roleB, reqRole], canManageRoles: false });
  const m = await buyer(8);
  const id = await item({ type: 'role', roleId: ROLE_B });
  const out = await buy(m, id);
  assert.equal(out.reason, 'cannot_grant');
  assert.match(out.message, /Manage Roles/);
  assert.equal(await cash(m), 1000);
  assert.equal((await getItem(G, id)).sold, 0);
  assert.equal((await listInventory(G, m.id)).length, 0);
});

test('a temporary role is given with a record that expires, and buying it again adds the time', async () => {
  const m = await buyer(9, 1000);
  const id = await item({
    name: 'Millionaire',
    type: 'temp_role',
    roleId: ROLE_A,
    durationHours: 24,
    price: 100,
  });
  const t0 = Date.now();
  const first = await buy(m, id, { now: t0 });
  assert.equal(first.ok, true);
  assert.equal(first.expiresAt, t0 + 24 * HOUR);
  assert.equal(first.extended, false);
  assert.deepEqual(m.adds, [ROLE_A]);
  const rec = await getTempRole(G, m.id, ROLE_A);
  assert.equal(rec.expires_at, t0 + 24 * HOUR);

  const second = await buy(m, id, { now: t0 + HOUR });
  assert.equal(second.extended, true);
  assert.equal(
    second.expiresAt,
    t0 + 48 * HOUR,
    'the new day is added to what was left, not counted from now'
  );
  assert.equal((await getTempRole(G, m.id, ROLE_A)).expires_at, t0 + 48 * HOUR);
  assert.deepEqual(m.adds, [ROLE_A], 'the role was already there: not added twice');
  assert.equal(await cash(m), 800);
});

test('a temporary role that already ran out starts again from now, and the extension is capped at 365 days', async () => {
  const m = await buyer(10, 5000);
  const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 8760, price: 10 });
  const t0 = Date.now();
  const first = await buy(m, id, { now: t0 });
  assert.equal(first.expiresAt, t0 + 8760 * HOUR);
  const again = await buy(m, id, { now: t0 + HOUR });
  assert.equal(again.expiresAt, t0 + HOUR + 8760 * HOUR, 'never more than 365 days from now');
});

test('if the platform refuses the role, the purchase is refunded, the stock and the temp-role record are put back', async () => {
  const m = await buyer(11, 1000);
  const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 24, price: 100, stock: 2 });
  m.failAdd = true;
  const out = await buy(m, id);
  assert.deepEqual([out.ok, out.reason, out.refunded], [false, 'grant_failed', true]);
  assert.equal(await cash(m), 1000, 'the money is back');
  assert.equal((await getItem(G, id)).sold, 0, 'and the stock');
  assert.equal(
    await getTempRole(G, m.id, ROLE_A),
    null,
    'and no record is left to take back a role that was never given'
  );
  const rows = await listInventory(G, m.id);
  assert.equal(rows[0].status, 'refunded');
  assert.deepEqual(
    ledger(m)
      .slice(-2)
      .map((r) => [r.kind, r.amount]),
    [
      ['purchase', -100],
      ['refund', 100],
    ]
  );
});

test('a failed grant on a role the member already had as a temporary role restores the earlier time', async () => {
  const m = await buyer(12, 1000);
  const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 24, price: 100 });
  const t0 = Date.now();
  await buy(m, id, { now: t0 });
  // the role is gone from the member (taken off by hand) so the next grant needs the platform
  m.roles.cache.delete(ROLE_A);
  m.failAdd = true;
  const out = await buy(m, id, { now: t0 + HOUR });
  assert.equal(out.reason, 'grant_failed');
  assert.equal((await getTempRole(G, m.id, ROLE_A)).expires_at, t0 + 24 * HOUR, 'back to what it was');
  assert.equal(await cash(m), 900);
});

test('a role that was deleted from the server is refused before any money moves', async () => {
  const m = await buyer(13);
  const id = await item({ type: 'role', roleId: ROLE_B });
  ctx.guild.roles.cache.delete(ROLE_B);
  const out = await buy(m, id);
  assert.equal(out.reason, 'cannot_grant');
  assert.equal(await cash(m), 1000);
});

// --- grant, revoke, refund, fulfil ------------------------------------------------------------------------

test('staff can give an item for free: a grant row of amount 0, no stock used, and a role goes on', async () => {
  const m = await buyer(14, 0);
  const id = await item({ name: 'Legend', type: 'role', roleId: ROLE_B, price: 300, stock: 1 });
  const out = await grantItem({
    guild: ctx.guild,
    member: m,
    itemId: id,
    by: 'staff1',
    reason: 'event prize',
    config: cfg(),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(m.adds, [ROLE_B]);
  assert.equal((await getItem(G, id)).sold, 0, 'a gift is not a sale');
  const row = (await listInventory(G, m.id))[0];
  assert.deepEqual([row.source, row.pricePaid, row.status], ['grant', 0, 'active']);
  const last = db
    .prepare(
      'SELECT kind, amount, actor_id, reason FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1'
    )
    .get(G, m.id);
  assert.deepEqual({ ...last }, { kind: 'grant', amount: 0, actor_id: 'staff1', reason: 'event prize' });
  assert.equal(await cash(m), 0);
});

test('a free grant of a temporary role extends too, and a paused item can still be given', async () => {
  const m = await buyer(15, 0);
  const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 2, enabled: false });
  const t0 = Date.now();
  await grantItem({ guild: ctx.guild, member: m, itemId: id, config: cfg(), now: t0 });
  await grantItem({ guild: ctx.guild, member: m, itemId: id, config: cfg(), now: t0 + 1000 });
  assert.equal((await getTempRole(G, m.id, ROLE_A)).expires_at, t0 + 4 * HOUR);
});

test('revoking a permanent role takes the role off and writes a revoke row of amount 0', async () => {
  const m = await buyer(16);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100 });
  await buy(m, id);
  const row = (await listInventory(G, m.id))[0];
  const out = await endRow({
    guild: ctx.guild,
    rowId: row.id,
    mode: 'revoke',
    by: 'staff1',
    reason: 'rule break',
    config: cfg(),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(m.removes, [ROLE_B]);
  assert.equal(m.roles.cache.has(ROLE_B), false);
  assert.equal((await getInventoryRow(G, row.id)).status, 'revoked');
  assert.equal(await cash(m), 900, 'a revoke gives no money back');
  assert.deepEqual(ledger(m).at(-1), { kind: 'revoke', amount: 0, cash_after: 900, reason: 'rule break' });
  assert.equal((await getItem(G, id)).sold, 1, 'and the stock stays used');
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: row.id, mode: 'revoke', config: cfg() })).reason,
    'not_active'
  );
});

test('revoking a temporary role ends its record and takes the role off; a second purchase keeps it until that is revoked too', async () => {
  const m = await buyer(17);
  const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 24, price: 50 });
  await buy(m, id);
  await buy(m, id);
  const [second, first] = await listInventory(G, m.id);
  await endRow({ guild: ctx.guild, rowId: second.id, mode: 'revoke', config: cfg() });
  assert.notEqual(await getTempRole(G, m.id, ROLE_A), null, 'the other purchase still holds the role');
  assert.deepEqual(m.removes, []);
  await endRow({ guild: ctx.guild, rowId: first.id, mode: 'revoke', config: cfg() });
  assert.equal(await getTempRole(G, m.id, ROLE_A), null);
  assert.deepEqual(m.removes, [ROLE_A]);
});

test('a refund gives the money back, returns the stock, revokes the item and cannot be repeated', async () => {
  const m = await buyer(18);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 250, stock: 3 });
  await buy(m, id);
  const row = (await listInventory(G, m.id))[0];
  const out = await endRow({
    guild: ctx.guild,
    rowId: row.id,
    mode: 'refund',
    by: 'staff1',
    reason: 'mistake',
    config: cfg(),
  });
  assert.deepEqual([out.ok, out.refunded], [true, true]);
  assert.equal(await cash(m), 1000);
  assert.equal((await getItem(G, id)).sold, 0);
  assert.equal(m.roles.cache.has(ROLE_B), false);
  assert.equal((await getInventoryRow(G, row.id)).status, 'refunded');
  assert.deepEqual(ledger(m).at(-1), { kind: 'refund', amount: 250, cash_after: 1000, reason: 'mistake' });
  const twice = await endRow({ guild: ctx.guild, rowId: row.id, mode: 'refund', config: cfg() });
  assert.equal(twice.reason, 'not_active');
  assert.equal(await cash(m), 1000, 'no second refund');
});

test('refunding a free grant is just a revoke, and an unknown row is refused', async () => {
  const m = await buyer(19, 0);
  const id = await item({ type: 'role', roleId: ROLE_B });
  await grantItem({ guild: ctx.guild, member: m, itemId: id, config: cfg() });
  const row = (await listInventory(G, m.id))[0];
  const out = await endRow({ guild: ctx.guild, rowId: row.id, mode: 'refund', config: cfg() });
  assert.deepEqual([out.ok, out.refunded], [true, false]);
  assert.equal(await cash(m), 0);
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: 999999, mode: 'revoke', config: cfg() })).reason,
    'not_found'
  );
});

test('a custom item is marked fulfilled once, with a note from staff', async () => {
  const m = await buyer(20);
  const id = await item();
  await buy(m, id);
  const row = (await listInventory(G, m.id))[0];
  assert.equal(await markFulfilled(G, row.id, 'staff1', 'done on stream'), true);
  assert.equal(await markFulfilled(G, row.id, 'staff2', 'again'), false);
  const after = await getInventoryRow(G, row.id);
  assert.deepEqual([after.fulfilledBy, after.note], ['staff1', 'done on stream']);
});

test('deleting an item keeps what members own, under its old name, and it can still be revoked and refunded', async () => {
  const m = await buyer(21);
  const id = await item({ name: 'Old thing', price: 80 });
  await buy(m, id);
  await deleteItem(G, id);
  assert.equal(await getItem(G, id), null);
  const row = (await listInventory(G, m.id))[0];
  assert.equal(row.itemName, 'Old thing');
  assert.equal((await buy(m, id)).reason, 'item_gone');
  const out = await endRow({ guild: ctx.guild, rowId: row.id, mode: 'refund', config: cfg() });
  assert.equal(out.refunded, true);
  assert.equal(await cash(m), 1000);
});

test('the activity log lists purchases newest first, filtered by member and by item', async () => {
  const a = await buyer(22);
  const b = await buyer(23);
  const x = await item({ name: 'X' });
  const y = await item({ name: 'Y' });
  await buy(a, x);
  await buy(b, y);
  await buy(a, y);
  await grantItem({ guild: ctx.guild, member: a, itemId: x, config: cfg() });
  const all = await listActivity(G, {});
  assert.deepEqual(
    [all.total, all.rows.map((r) => r.itemName)],
    [3, ['Y', 'Y', 'X']],
    'gifts are not purchases'
  );
  assert.equal((await listActivity(G, { userId: a.id })).total, 2);
  assert.equal((await listActivity(G, { itemId: y })).total, 2);
  assert.equal((await listActivity(G, { userId: a.id, itemId: y })).total, 1);
  assert.equal((await listActivity(G, { purchasesOnly: false })).total, 4);
  assert.equal((await listActivity(G, { limit: 2, offset: 2 })).rows.length, 1);
});

test('a purchase stuck as pending (a restart between the commit and the role) is refunded by the sweep, or confirmed when the role is there', async () => {
  const a = await buyer(24);
  const b = await buyer(25);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100, stock: 5 });
  await buy(a, id);
  await buy(b, id);
  // both rows go back to pending, as if the process had stopped before the platform call finished
  db.prepare("UPDATE economy_inventory SET status = 'pending', lease_until = ? WHERE guild_id = ?").run(
    Date.now() - 60_000,
    G
  );
  a.roles.cache.delete(ROLE_B); // a never got the role; b did
  assert.equal(await recoverPending(Date.now()), 2);
  const rowOf = async (m) => (await listInventory(G, m.id))[0];
  assert.equal((await rowOf(a)).status, 'refunded');
  assert.equal(await cash(a), 1000, 'a is refunded');
  assert.equal((await getItem(G, id)).sold, 1, 'and the stock of a comes back');
  assert.equal((await rowOf(b)).status, 'active');
  assert.equal(await cash(b), 900, 'b keeps what was bought');
  assert.equal(await recoverPending(Date.now()), 0, 'nothing is left to settle');
});

test('pickItem finds an item by exact name, number or a unique part of the name', () => {
  const items = [
    { id: 1, name: 'Shout-out' },
    { id: 2, name: 'Millionaire' },
    { id: 3, name: 'Mini shout' },
  ];
  assert.equal(pickItem(items, 'millionaire').item.id, 2);
  assert.equal(pickItem(items, '3').item.id, 3);
  assert.equal(pickItem(items, 'illion').item.id, 2);
  const many = pickItem(items, 'shout');
  assert.equal(many.item, null);
  assert.equal(many.ambiguous.length, 2);
  assert.equal(pickItem(items, '9').item, null);
  assert.equal(pickItem(items, '  ').item, null);
});

test('item fields are clamped: name 60, description 300, price at least 1, duration 1 hour to 365 days, stock and limit', () => {
  const v = normaliseItem({
    name: 'x'.repeat(80),
    description: 'd'.repeat(400),
    type: 'temp_role',
    roleId: ROLE_A,
    durationHours: 99999,
    price: -5,
    stock: '12',
    perMemberLimit: 0,
    requiredRoles: Array.from({ length: 20 }, (_, i) => `70000000000000${String(i).padStart(4, '0')}`),
  });
  assert.equal(v.name.length, 60);
  assert.equal(v.description.length, 300);
  assert.equal(v.durationMs, 8760 * HOUR);
  assert.equal(v.price, 1);
  assert.equal(v.stock, 12);
  assert.equal(v.perMemberLimit, 1);
  assert.equal(v.requiredRoles.length, 10);
  assert.equal(normaliseItem({ type: 'temp_role', durationHours: 0 }).durationMs, HOUR);
  assert.equal(normaliseItem({ stock: '' }).stock, null);
  assert.equal(normaliseItem({ type: 'bogus' }).type, 'custom');
  assert.equal(normaliseItem({ type: 'custom', roleId: ROLE_A }).roleId, null, 'a custom item has no role');
  assert.equal(normaliseItem({ type: 'role', roleId: 'nope' }).roleId, null);
});

// --- fix round: the price the member saw, expired temp roles, time added, forget, leases ----------------

const DAY = 24 * HOUR;
const tempItem = (over = {}) =>
  item({ type: 'temp_role', roleId: ROLE_A, durationHours: 24, price: 100, ...over });
const record = async (m, roleId = ROLE_A) => getTempRole(G, m.id, roleId);

test('purchase() charges only the price the buyer saw: a changed price is refused with the new one', async () => {
  const m = await buyer(60);
  const id = await item({ price: 100 });
  // the buyer saw 100; staff raise it to 5000
  await updateItem(G, id, normaliseItem({ name: 'Shout-out', price: 5000, type: 'custom' }));
  const out = await buy(m, id, { expectedPrice: 100 });
  assert.deepEqual([out.ok, out.reason, out.price], [false, 'price_changed', 5000]);
  assert.equal(await cash(m), 1000, 'nothing was charged');
  assert.equal((await getItem(G, id)).sold, 0);
  assert.deepEqual(await ledger(m), [{ kind: 'staff_add', amount: 1000, cash_after: 1000, reason: '' }]);
  assert.match(shopRefusalText(out, cfg()), /The price changed to 🪙 5,000 coins\. Check and try again\./);
  // the price after the change works, a price that was never given does not
  assert.equal((await buy(m, id, { expectedPrice: 5000 })).reason, 'insufficient');
  assert.equal((await buy(m, id, { expectedPrice: undefined })).reason, 'price_changed');
  assert.equal((await buy(m, id, { expectedPrice: NaN })).reason, 'price_changed');
  await updateItem(G, id, normaliseItem({ name: 'Shout-out', price: 40, type: 'custom' }));
  const ok = await buy(m, id, { expectedPrice: 40 });
  assert.equal(ok.ok, true);
  assert.equal(await cash(m), 960);
});

test('a temporary role that ran out is marked expired: it does not count against the limit, is not revoked or refunded, and a new purchase can be ended', async () => {
  const m = await buyer(61);
  const id = await tempItem({ perMemberLimit: 1, durationHours: 168 });
  assert.equal((await buy(m, id)).ok, true);
  assert.equal((await buy(m, id)).reason, 'limit');
  const [first] = await listInventory(G, m.id);
  // a week and a bit later the temp-role sweep takes the role back
  await tempRoleSweep(Date.now() + 8 * DAY);
  assert.equal(m.roles.cache.has(ROLE_A), false, 'the role came off');
  assert.equal(await record(m), null);
  assert.equal((await getInventoryRow(G, first.id)).status, 'expired');
  assert.deepEqual(await endRow({ guild: ctx.guild, rowId: first.id, mode: 'refund', config: cfg() }), {
    ok: false,
    reason: 'not_active',
  });
  assert.equal(await cash(m), 900, 'an expired purchase is not refunded');

  // the limit counts only what runs: it can be bought again, and ending THAT one removes the role
  const again = await buy(m, id);
  assert.equal(again.ok, true);
  assert.equal(m.roles.cache.has(ROLE_A), true);
  const done = await endRow({ guild: ctx.guild, rowId: again.row.id, mode: 'refund', config: cfg() });
  assert.deepEqual([done.ok, done.refunded], [true, true]);
  assert.equal(m.roles.cache.has(ROLE_A), false, 'the refund took the role off');
  assert.equal(await record(m), null);
  assert.equal(await cash(m), 900);
});

test('a role that was taken off by hand ends the temporary purchase too', async () => {
  const m = await buyer(62);
  const id = await tempItem();
  const bought = await buy(m, id);
  const { expireShopTempRows } = await import('../src/db/economyShop.js');
  assert.equal(await expireShopTempRows(G, m.id, ROLE_A), 1);
  assert.equal((await getInventoryRow(G, bought.row.id)).status, 'expired');
  assert.equal(await expireShopTempRows(G, m.id, ROLE_A), 0, 'nothing left to end');
});

test('a refund or revoke takes off only the time its own purchase added, and never past now', async () => {
  const m = await buyer(63);
  const id = await tempItem({ durationHours: 24 });
  const one = await buy(m, id);
  const two = await buy(m, id);
  const t0 = (await record(m)).expires_at;
  assert.equal((await getInventoryRow(G, two.row.id)).addedMs, DAY);
  // refund the second purchase: one day goes, one day stays, the role stays
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: two.row.id, mode: 'refund', config: cfg() })).ok,
    true
  );
  assert.equal((await record(m)).expires_at, t0 - DAY);
  assert.equal(m.roles.cache.has(ROLE_A), true);
  // revoke the first: nothing is left, the role comes off
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: one.row.id, mode: 'revoke', config: cfg() })).ok,
    true
  );
  assert.equal(await record(m), null);
  assert.equal(m.roles.cache.has(ROLE_A), false);

  // time staff gave by hand stays
  const n2 = await buyer(64);
  await putTempRole({
    guildId: G,
    userId: n2.id,
    roleId: ROLE_A,
    expiresAt: Date.now() + 10 * DAY,
    addedBy: 'staff',
    reason: 'gift',
  });
  n2.roles.cache.set(ROLE_A, roleA);
  const bought = await buy(n2, id);
  const staffExpiry = Date.now() + 10 * DAY;
  assert.ok(
    Math.abs((await record(n2)).expires_at - (staffExpiry + DAY)) < 5000,
    'a day was added to the staff time'
  );
  await endRow({ guild: ctx.guild, rowId: bought.row.id, mode: 'refund', config: cfg() });
  const left = await record(n2);
  assert.ok(Math.abs(left.expires_at - staffExpiry) < 5000, 'only the purchased day went');
  assert.equal(n2.roles.cache.has(ROLE_A), true);

  // never past now: a record that has less left than the row added is ended and the role comes off
  const n3 = await buyer(65);
  const short = await buy(n3, id);
  await putTempRole({
    guildId: G,
    userId: n3.id,
    roleId: ROLE_A,
    expiresAt: Date.now() + HOUR,
    addedBy: null,
    reason: 'x',
  });
  await endRow({ guild: ctx.guild, rowId: short.row.id, mode: 'revoke', config: cfg() });
  assert.equal(await record(n3), null);
  assert.equal(n3.roles.cache.has(ROLE_A), false);
});

test('two parallel buys of a permanent role charge once', async () => {
  const m = await buyer(66);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100 });
  const results = await Promise.all([buy(m, id), buy(m, id), buy(m, id)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'already_has_role'));
  assert.equal(await cash(m), 900, 'charged once');
  assert.equal((await getItem(G, id)).sold, 1);
  assert.equal((await listInventory(G, m.id)).length, 1);
  assert.equal(m.adds.filter((r) => r === ROLE_B).length, 1);
});

/** A member whose role grant waits until `release()` is called. */
function slowMember(m) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const add = m.roles.add;
  let started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  m.roles.add = async (role) => {
    started();
    await gate;
    return add(role);
  };
  return { release, begun };
}

test('the sweep leaves a role grant that is still running alone, and a revoke waits for it', async () => {
  const m = await buyer(67);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100 });
  const slow = slowMember(m);
  const buying = buy(m, id);
  await slow.begun;
  // the row is pending, and even with its lease long over the grant that is running is not touched
  const [row] = await listInventory(G, m.id);
  assert.equal(row.status, 'pending');
  db.prepare('UPDATE economy_inventory SET lease_until = 0 WHERE id = ?').run(row.id);
  assert.equal(await recoverPending(Date.now() + 60 * 60_000), 0);
  assert.equal(await cash(m), 900, 'not refunded');

  // staff revoke it while the grant is running: the revoke waits, so the role cannot be left behind
  const revoking = endRow({ guild: ctx.guild, rowId: row.id, mode: 'revoke', config: cfg() });
  slow.release();
  const [bought, revoked] = await Promise.all([buying, revoking]);
  assert.equal(bought.ok, true);
  assert.equal(revoked.ok, true);
  assert.equal((await getInventoryRow(G, row.id)).status, 'revoked');
  assert.equal(m.roles.cache.has(ROLE_B), false, 'the member does not keep the role after a revoke');
});

test('a grant that lands after its row was ended takes the role off again', async () => {
  const m = await buyer(68);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100 });
  const slow = slowMember(m);
  const buying = buy(m, id);
  await slow.begun;
  const [row] = await listInventory(G, m.id);
  // the row is ended behind the grant's back (as the sweep of another process could)
  db.prepare("UPDATE economy_inventory SET status = 'revoked' WHERE id = ?").run(row.id);
  slow.release();
  const out = await buying;
  assert.deepEqual([out.ok, out.reason], [false, 'grant_ended']);
  assert.equal(m.roles.cache.has(ROLE_B), false, 'the role did not stay');
  assert.match(shopRefusalText(out, cfg()), /ended before the role arrived/);
});

test('the sweep refunds only a member who is gone or lacks the role, confirms one who has it, and waits when it cannot look', async () => {
  const a = await buyer(69);
  const b = await buyer(70);
  const c = await buyer(71);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100, stock: 9 });
  for (const m of [a, b, c]) await buy(m, id);
  const stale = () =>
    db
      .prepare("UPDATE economy_inventory SET status = 'pending', lease_until = ? WHERE guild_id = ?")
      .run(Date.now() - 1000, G);
  stale();
  // a is not in the cache and the lookup fails with something that is not "gone": try again later
  ctx.guild.members.cache.delete(a.id);
  const realFetch = ctx.guild.members.fetch;
  ctx.guild.members.fetch = async (uid) => {
    if (uid === a.id) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    return realFetch(uid);
  };
  c.roles.cache.delete(ROLE_B); // c never got the role
  assert.equal(await recoverPending(Date.now()), 2, 'b is confirmed, c is refunded');
  const status = async (m) => (await listInventory(G, m.id))[0].status;
  assert.deepEqual([await status(a), await status(b), await status(c)], ['pending', 'active', 'refunded']);
  assert.equal(await cash(a), 900, 'not refunded while it could not be looked at');
  // now a is known to be gone (a 404): refunded
  ctx.guild.members.fetch = realFetch;
  assert.equal(await recoverPending(Date.now()), 1);
  assert.equal(await status(a), 'refunded');
  assert.equal(await cash(a), 1000);
});

test('a lease keeps a fresh pending row from the sweep', async () => {
  const m = await buyer(72);
  const id = await item({ type: 'role', roleId: ROLE_B, price: 100 });
  await buy(m, id);
  db.prepare("UPDATE economy_inventory SET status = 'pending', lease_until = ? WHERE guild_id = ?").run(
    Date.now() + 60_000,
    G
  );
  m.roles.cache.delete(ROLE_B);
  assert.equal(await recoverPending(Date.now()), 0, 'inside its lease');
  assert.equal(await recoverPending(Date.now() + 120_000), 1, 'after it');
  assert.equal(await cash(m), 1000);
});

test('the pending sweep has an index, and /forget takes the roles the shop gave off first', async () => {
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM economy_inventory WHERE status = 'pending' AND lease_until < 5 ORDER BY lease_until, id LIMIT 50"
    )
    .all()
    .map((r) => r.detail)
    .join(' ');
  assert.match(plan, /idx_economy_inventory_pending/);

  const m = await buyer(73);
  const temp = await tempItem();
  const perm = await item({ name: 'Legend', type: 'role', roleId: ROLE_B, price: 50 });
  await buy(m, temp);
  await buy(m, perm);
  assert.deepEqual([m.roles.cache.has(ROLE_A), m.roles.cache.has(ROLE_B)], [true, true]);
  const out = await endShopRolesForForget(ctx.guild, m.id);
  assert.deepEqual([out.roles, out.removed, out.failed], [2, 2, []]);
  assert.deepEqual([m.roles.cache.has(ROLE_A), m.roles.cache.has(ROLE_B)], [false, false]);
  // a member with nothing from the shop: nothing to do
  assert.deepEqual(await endShopRolesForForget(ctx.guild, (await buyer(74)).id), {
    roles: 0,
    removed: 0,
    failed: [],
  });
});
