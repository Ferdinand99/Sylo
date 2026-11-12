// Shop data handling: the migration's tables, /forget (the inventory goes, a staff name comes off), the
// member's data export, the guild purge, and that items are server data rather than personal data.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { createItem, listInventory, listItems, markFulfilled } from '../src/db/economyShop.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem } from '../src/modules/lib/economyConfig.js';
import { purchase } from '../src/modules/lib/shop.js';
import { dropFakeShop, fakeMember, fakeShopGuild } from './helpers/fakeShop.js';

let n = 0;
let G;
let ctx;
const config = normaliseEconomyConfig({});
const U = '8200000000000001';
const STAFF = '8200000000000002';

beforeEach(() => {
  G = `6000000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G);
});
afterEach(() => dropFakeShop());

async function seed() {
  const m = fakeMember(U);
  ctx.guild.members.cache.set(U, m);
  await credit(G, U, 1000, { kind: 'staff_add', config });
  const id = await createItem(G, normaliseItem({ name: 'Shout-out', price: 100, type: 'custom' }));
  await purchase({ guild: ctx.guild, member: m, itemId: id, config });
  await purchase({ guild: ctx.guild, member: m, itemId: id, config });
  const rows = await listInventory(G, U);
  await markFulfilled(G, rows[0].id, STAFF, 'done');
  return { m, id, rows };
}
const count = (table, extra = '', ...args) =>
  db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE guild_id = ? ${extra}`).get(G, ...args).c;

test('the migration made both tables with the documented columns, and both are in GUILD_TABLES', () => {
  const cols = (t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
  assert.deepEqual(cols('economy_items'), [
    'id',
    'guild_id',
    'name',
    'description',
    'emoji',
    'type',
    'role_id',
    'duration_ms',
    'price',
    'stock',
    'sold',
    'required_roles',
    'per_member_limit',
    'enabled',
    'sort_order',
    'created_at',
    'updated_at',
  ]);
  assert.deepEqual(cols('economy_inventory'), [
    'id',
    'guild_id',
    'user_id',
    'item_id',
    'item_name',
    'item_type',
    'role_id',
    'price_paid',
    'source',
    'status',
    'fulfilled_at',
    'fulfilled_by',
    'note',
    'created_at',
    'updated_at',
  ]);
  assert.ok(GUILD_TABLES.includes('economy_items') && GUILD_TABLES.includes('economy_inventory'));
  assert.deepEqual(cols('giveaways').slice(-3), ['entry_fee', 'prize_amount', 'cancelled']);
});

test('/forget deletes the member inventory and nothing of other members, and the item stays', async () => {
  const { id } = await seed();
  const other = fakeMember('8200000000000003');
  ctx.guild.members.cache.set(other.id, other);
  await credit(G, other.id, 500, { kind: 'staff_add', config });
  await purchase({ guild: ctx.guild, member: other, itemId: id, config });
  const out = await forgetUser(G, U);
  assert.equal(out.economyInventory, 2);
  assert.equal(count('economy_inventory', 'AND user_id = ?', U), 0);
  assert.equal(count('economy_inventory', 'AND user_id = ?', other.id), 1);
  assert.equal((await listItems(G)).length, 1, "the shop item is the server's, not the member's");
});

test('/forget takes the name of a staff member off the items they marked fulfilled', async () => {
  const { rows } = await seed();
  const out = await forgetUser(G, STAFF);
  assert.equal(out.economyFulfilled, 1);
  const row = db
    .prepare('SELECT fulfilled_by, fulfilled_at, note FROM economy_inventory WHERE id = ?')
    .get(rows[0].id);
  assert.equal(row.fulfilled_by, null);
  assert.ok(row.fulfilled_at, 'the item is still fulfilled');
});

test('the member data export lists the inventory, and what a staff member fulfilled without who it was for', async () => {
  await seed();
  const dump = await exportUserData(G, U);
  assert.equal(dump.data.economyInventory.length, 2);
  assert.deepEqual(
    dump.data.economyInventory.map((r) => [r.item_name, r.source, r.status]),
    [
      ['Shout-out', 'purchase', 'active'],
      ['Shout-out', 'purchase', 'active'],
    ]
  );
  const staff = await exportUserData(G, STAFF);
  assert.deepEqual(Object.keys(staff.data.economyFulfilled[0]).sort(), ['fulfilled_at', 'item_name']);
  const described = await describeUserData(G, U);
  const item = (key) => described.items.find((i) => i.key === key);
  assert.equal(item('economyInventory').count, 2);
  assert.equal(item('economyInventory').kept, false);
  assert.deepEqual(Object.keys(dump.data).sort(), described.items.map((i) => i.key).sort());
});

test('after /forget the export holds no inventory', async () => {
  await seed();
  await forgetUser(G, U);
  assert.deepEqual((await exportUserData(G, U)).data.economyInventory, []);
});

test('the guild purge removes the items and every inventory row of the server only', async () => {
  await seed();
  const other = `${G}9`;
  await createItem(other, normaliseItem({ name: 'Other', price: 1 }));
  await purgeGuild(G);
  assert.equal(count('economy_items'), 0);
  assert.equal(count('economy_inventory'), 0);
  assert.equal((await listItems(other)).length, 1);
});
