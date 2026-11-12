// The shop part of the Economy page of the dashboard: items (create, edit, pause, reorder, delete), a
// member's inventory (give, revoke, refund, mark fulfilled) and the activity log, through /api/v2 with
// the stored rows, the ledger and the audit log asserted. Who may call these routes is in
// v2.permissionsEconomy.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, ROLE } from './helpers/fakeGuild.js';
import { buyNow, fakeMember } from './helpers/fakeShop.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import { createItem, getItem, listItems } from '../src/db/economyShop.js';
import { setGuildModule } from '../src/db/modules.js';
import { getTempRole } from '../src/db/tempRoles.js';
import { purgeGuild } from '../src/db/purge.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseItem } from '../src/modules/lib/economyConfig.js';

let app;
let api;
const U = '700000000000000011';
const V = '700000000000000012';
const BOT = '700000000000000013';
const config = {};
const members = {};

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());
beforeEach(async () => {
  await purgeGuild(GID);
  for (const [id, bot] of [
    [U, false],
    [V, false],
    [BOT, true],
  ]) {
    members[id] = fakeMember(id, { bot });
    app.guild.members.cache.set(id, members[id]);
  }
  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
});

const json = (res) => res.json();
const roleId = ROLE.member; // a role the fake server has and Sylo can hand out
const add = (body) =>
  api.post('/modules/economy/shop/items', { name: 'Shout-out', price: 100, type: 'custom', ...body });
const give = (id, userId = U) => credit(GID, userId, id, { kind: 'staff_add', config });
const cash = async (id) => Number((await getAccount(GID, id))?.cash ?? 0);

test('items are created with every field clamped, listed in order, and counted in the audit log', async () => {
  const res = await add({
    name: ` ${'x'.repeat(80)} `,
    description: 'd'.repeat(400),
    price: -3,
    stock: '5',
    perMemberLimit: '2',
  });
  assert.equal(res.status, 200);
  const { items } = await json(res);
  assert.equal(items.length, 1);
  assert.deepEqual(
    [
      items[0].name.length,
      items[0].description.length,
      items[0].price,
      items[0].stock,
      items[0].left,
      items[0].perMemberLimit,
      items[0].enabled,
    ],
    [60, 300, 1, 5, 5, 2, true]
  );
  await add({ name: 'Second', type: 'role', roleId });
  await add({ name: 'Third', type: 'temp_role', roleId, durationHours: 48 });
  const list = await json(await api.get('/modules/economy/shop/items'));
  assert.deepEqual(
    list.items.map((i) => i.name),
    ['x'.repeat(60), 'Second', 'Third']
  );
  assert.equal(list.items[2].durationHours, 48);
  assert.ok(list.roles.some((r) => r.id === roleId));
  assert.equal((await auditRows(GID, 'economy:shop')).length, 3);
});

test('an item needs a name, and a role item needs a role that the server has', async () => {
  assert.equal((await add({ name: '  ' })).status, 400);
  const noRole = await add({ type: 'role', roleId: '' });
  assert.equal(noRole.status, 400);
  assert.match((await json(noRole)).error, /Pick the role/);
  const bogus = await add({ type: 'temp_role', roleId: '123456789012345678', durationHours: 5 });
  assert.equal(bogus.status, 400);
  assert.match((await json(bogus)).error, /Pick a role from the list/);
  const managed = await add({ type: 'role', roleId: ROLE.bot }); // a managed role cannot be handed out
  assert.equal(managed.status, 400);
  assert.equal((await listItems(GID)).length, 0);
});

test('a server can have at most 100 items', async () => {
  for (let i = 0; i < 100; i++) await createItem(GID, normaliseItem({ name: `Item ${i}`, price: 1 }));
  const res = await add({ name: 'One too many' });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /maximum of 100 shop items/);
});

test('items can be edited, paused and resumed, reordered and deleted', async () => {
  const a = (await json(await add({ name: 'A' }))).id;
  const b = (await json(await add({ name: 'B' }))).id;
  const c = (await json(await add({ name: 'C' }))).id;

  const edited = await json(
    await api.post(`/modules/economy/shop/items/${a}`, { name: 'A2', price: 250, type: 'custom', stock: '' })
  );
  assert.deepEqual([edited.items[0].name, edited.items[0].price, edited.items[0].stock], ['A2', 250, null]);
  assert.equal((await api.post('/modules/economy/shop/items/999999', { name: 'x', price: 1 })).status, 404);
  assert.equal((await api.post(`/modules/economy/shop/items/${a}`, { name: '' })).status, 400);

  const paused = await json(await api.post(`/modules/economy/shop/items/${b}/enabled`, { enabled: false }));
  assert.equal(paused.items.find((i) => i.id === b).enabled, false);
  const resumed = await json(await api.post(`/modules/economy/shop/items/${b}/enabled`, { enabled: true }));
  assert.equal(resumed.items.find((i) => i.id === b).enabled, true);

  const order = await json(
    await api.post('/modules/economy/shop/items/order', { ids: [c, a, 'junk', 999999] })
  );
  assert.deepEqual(
    order.items.map((i) => i.id),
    [c, a, b],
    'listed ids first, the rest after, junk ignored'
  );

  const del = await json(await api.post(`/modules/economy/shop/items/${a}/delete`, {}));
  assert.deepEqual(
    del.items.map((i) => i.id),
    [c, b]
  );
  assert.equal(await getItem(GID, a), null);
  assert.equal((await api.post(`/modules/economy/shop/items/${a}/delete`, {})).status, 404);
});

test('sales counts and revenue show on the item, and refunds take them back', async () => {
  const id = (await json(await add({ price: 40, stock: 10 }))).id;
  await give(500);
  const guild = app.guild;
  const m = members[U];
  await buyNow({ guild, member: m, itemId: id, config: {} });
  await buyNow({ guild, member: m, itemId: id, config: {} });
  const item = (await json(await api.get('/modules/economy/shop/items'))).items[0];
  assert.deepEqual([item.sold, item.left, item.purchases, item.revenue], [2, 8, 2, 80]);
});

test('staff give an item for free, revoke it and see it in the member page', async () => {
  const id = (await json(await add({ name: 'Legend', type: 'role', roleId, price: 300 }))).id;
  const grant = await api.post(`/modules/economy/members/${U}/inventory/grant`, {
    itemId: id,
    reason: 'event prize',
  });
  assert.equal(grant.status, 200);
  const { inventory } = await json(grant);
  assert.deepEqual(
    [
      inventory.length,
      inventory[0].itemName,
      inventory[0].source,
      inventory[0].status,
      inventory[0].pricePaid,
    ],
    [1, 'Legend', 'grant', 'active', 0]
  );
  assert.deepEqual(members[U].adds, [roleId]);
  const ledger = db
    .prepare(
      "SELECT kind, amount, reason FROM economy_transactions WHERE guild_id = ? AND user_id = ? AND kind = 'grant'"
    )
    .get(GID, U);
  assert.deepEqual({ ...ledger }, { kind: 'grant', amount: 0, reason: 'event prize' });

  const detail = await json(await api.get(`/modules/economy/members/${U}`));
  assert.equal(detail.inventory.length, 1);
  assert.equal(
    (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0].itemName,
    'Legend'
  );

  const revoke = await api.post(`/modules/economy/members/${U}/inventory/${inventory[0].id}/revoke`, {
    reason: 'abuse',
  });
  assert.equal(revoke.status, 200);
  assert.equal((await json(revoke)).inventory[0].status, 'revoked');
  assert.deepEqual(members[U].removes, [roleId]);
  assert.equal(
    (await api.post(`/modules/economy/members/${U}/inventory/${inventory[0].id}/revoke`, {})).status,
    400,
    'already revoked'
  );
  assert.equal((await auditRows(GID, 'economy:inventory')).length, 2);
});

test('a temporary role granted and revoked from the dashboard ends its record', async () => {
  const id = (await json(await add({ type: 'temp_role', roleId, durationHours: 24 }))).id;
  const out = await json(await api.post(`/modules/economy/members/${U}/inventory/grant`, { itemId: id }));
  assert.ok(out.inventory[0].expiresAt > Date.now(), 'the page shows when it ends');
  assert.notEqual(await getTempRole(GID, U, roleId), null);
  await api.post(`/modules/economy/members/${U}/inventory/${out.inventory[0].id}/revoke`, {});
  assert.equal(await getTempRole(GID, U, roleId), null);
  assert.deepEqual(members[U].removes, [roleId]);
});

test('a refund gives the money back through the money API, revokes the item and cannot be repeated', async () => {
  const id = (await json(await add({ type: 'role', roleId, price: 150, stock: 4 }))).id;
  await give(400);
  const bought = await buyNow({ guild: app.guild, member: members[U], itemId: id, config: {} });
  assert.equal(bought.ok, true);
  assert.equal(await cash(U), 250);
  const row = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  const refund = await api.post(`/modules/economy/members/${U}/inventory/${row.id}/refund`, {
    reason: 'mistake',
  });
  assert.equal(refund.status, 200);
  const body = await json(refund);
  assert.deepEqual([body.refunded, body.inventory[0].status], [true, 'refunded']);
  assert.equal(await cash(U), 400);
  assert.equal((await getItem(GID, id)).sold, 0);
  const last = db
    .prepare(
      "SELECT kind, amount, actor_id, reason FROM economy_transactions WHERE guild_id = ? AND user_id = ? AND kind = 'refund'"
    )
    .get(GID, U);
  assert.deepEqual({ ...last }, { kind: 'refund', amount: 150, actor_id: null, reason: 'mistake' });
  assert.equal((await api.post(`/modules/economy/members/${U}/inventory/${row.id}/refund`, {})).status, 400);
  assert.equal(await cash(U), 400, 'no second refund');
});

test('custom items are marked fulfilled and reopened, with a note from staff', async () => {
  const id = (await json(await add({ name: 'Shout-out' }))).id;
  await give(500);
  await buyNow({ guild: app.guild, member: members[U], itemId: id, config: {} });
  const rowId = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0].id;
  const done = await json(
    await api.post(`/modules/economy/members/${U}/inventory/${rowId}/fulfil`, { note: 'done on stream' })
  );
  assert.ok(done.inventory[0].fulfilledAt);
  assert.equal(done.inventory[0].note, 'done on stream');
  assert.equal(
    (await api.post(`/modules/economy/members/${U}/inventory/${rowId}/fulfil`, {})).status,
    400,
    'already fulfilled'
  );
  const reopened = await json(
    await api.post(`/modules/economy/members/${U}/inventory/${rowId}/fulfil`, { fulfilled: false })
  );
  assert.equal(reopened.inventory[0].fulfilledAt, null);
});

test('what a member sees as the item: an inventory row of a deleted item says "item removed"', async () => {
  const id = (await json(await add({ name: 'Gone soon' }))).id;
  await give(500);
  await buyNow({ guild: app.guild, member: members[U], itemId: id, config: {} });
  await api.post(`/modules/economy/shop/items/${id}/delete`, {});
  const row = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.deepEqual([row.itemName, row.itemRemoved], ['Gone soon', true]);
});

test('the activity log lists purchases, filtered by member and by item, a page at a time', async () => {
  const x = (await json(await add({ name: 'X', price: 5 }))).id;
  const y = (await json(await add({ name: 'Y', price: 5 }))).id;
  await give(500, U);
  await give(500, V);
  for (let i = 0; i < 14; i++) await buyNow({ guild: app.guild, member: members[U], itemId: x, config: {} });
  for (let i = 0; i < 12; i++) await buyNow({ guild: app.guild, member: members[V], itemId: y, config: {} });
  const page1 = await json(await api.get('/modules/economy/shop/activity'));
  assert.deepEqual([page1.rows.length, page1.total, page1.pages, page1.page], [25, 26, 2, 1]);
  assert.equal(page1.rows[0].itemName, 'Y', 'newest first');
  const page2 = await json(await api.get('/modules/economy/shop/activity?page=2'));
  assert.equal(page2.rows.length, 1);
  const byMember = await json(await api.get(`/modules/economy/shop/activity?userId=${U}`));
  assert.equal(byMember.total, 14);
  assert.equal(byMember.rows[0].member.id, U);
  const byItem = await json(await api.get(`/modules/economy/shop/activity?itemId=${y}`));
  assert.equal(byItem.total, 12);
  const both = await json(await api.get(`/modules/economy/shop/activity?userId=${V}&itemId=${x}`));
  assert.equal(both.total, 0);
  const junk = await json(await api.get('/modules/economy/shop/activity?userId=abc&itemId=zz'));
  assert.equal(junk.total, 26, 'filters that are not ids are ignored');
});

test('the dashboard refuses what it must: module off, unknown item, bots, people who left, rows of someone else', async () => {
  const id = (await json(await add({}))).id;
  const grant = (userId, body) => api.post(`/modules/economy/members/${userId}/inventory/grant`, body);
  assert.equal((await grant('nope', { itemId: id })).status, 400);
  assert.equal((await grant(U, { itemId: 'x' })).status, 400);
  assert.equal((await grant(U, { itemId: 999999 })).status, 404);
  assert.match((await json(await grant(BOT, { itemId: id }))).error, /Bots/);
  const realFetch = app.guild.members.fetch;
  app.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  try {
    assert.match((await json(await grant('700000000000000099', { itemId: id }))).error, /not in this server/);
  } finally {
    app.guild.members.fetch = realFetch;
  }
  await setGuildModule(GID, 'economy', { enabled: false, config: {} });
  assert.match((await json(await grant(U, { itemId: id }))).error, /Turn the Economy module on/);
  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
  await grant(U, { itemId: id });
  const rowId = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0].id;
  assert.equal(
    (await api.post(`/modules/economy/members/${V}/inventory/${rowId}/revoke`, {})).status,
    404,
    "not V's row"
  );
  assert.equal((await api.post(`/modules/economy/members/${U}/inventory/999999/refund`, {})).status, 404);
});
