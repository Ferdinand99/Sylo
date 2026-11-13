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
import { buyNow, dropFakeShop, fakeMember, fakeShopGuild } from './helpers/fakeShop.js';

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
  await buyNow({ guild: ctx.guild, member: m, itemId: id, config });
  await buyNow({ guild: ctx.guild, member: m, itemId: id, config });
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
    'image_id',
    'rarity',
    'announce',
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
    'added_ms',
    'lease_until',
    'image_id',
    'rarity',
  ]);
  assert.ok(GUILD_TABLES.includes('economy_items') && GUILD_TABLES.includes('economy_inventory'));
  assert.deepEqual(cols('giveaways').slice(-6), [
    'entry_fee',
    'prize_amount',
    'cancelled',
    'prizes_paid',
    'drawn_at',
    'sweep_at',
  ]);
  assert.equal(cols('giveaway_entries').at(-1), 'refunded');
  assert.deepEqual(cols('giveaway_prizes'), ['giveaway_id', 'user_id', 'amount', 'paid_at']);
});

test('/forget deletes the member inventory and nothing of other members, and the item stays', async () => {
  const { id } = await seed();
  const other = fakeMember('8200000000000003');
  ctx.guild.members.cache.set(other.id, other);
  await credit(G, other.id, 500, { kind: 'staff_add', config });
  await buyNow({ guild: ctx.guild, member: other, itemId: id, config });
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

// --- /forget ends the roles the shop gave -----------------------------------------------------------------

test('/forget takes bought roles off before it deletes the records, and the confirmation says so', async () => {
  const { execute } = await import('../src/bot/commands/forget.js');
  const { getTempRole } = await import('../src/db/tempRoles.js');
  const ROLE_T = '700000000000000101';
  const ROLE_P = '700000000000000102';
  const g = fakeShopGuild(G, {
    roles: [
      { id: ROLE_T, name: 'Temp', position: 1, managed: false, editable: true },
      { id: ROLE_P, name: 'Perm', position: 1, managed: false, editable: true },
    ],
  });
  ctx = g;
  const m = fakeMember(U);
  g.guild.members.cache.set(U, m);
  await credit(G, U, 1000, { kind: 'staff_add', config });
  const temp = await createItem(
    G,
    normaliseItem({ name: 'Temp', type: 'temp_role', roleId: ROLE_T, durationHours: 24, price: 100 })
  );
  const perm = await createItem(G, normaliseItem({ name: 'Perm', type: 'role', roleId: ROLE_P, price: 100 }));
  await buyNow({ guild: g.guild, member: m, itemId: temp, config });
  await buyNow({ guild: g.guild, member: m, itemId: perm, config });
  assert.deepEqual([m.roles.cache.has(ROLE_T), m.roles.cache.has(ROLE_P)], [true, true]);
  assert.ok(await getTempRole(G, U, ROLE_T));

  const replies = [];
  const run = (confirm) =>
    execute({
      inGuild: () => true,
      guild: { ...g.guild, name: 'Shop Test' },
      guildId: G,
      user: m.user,
      options: { getBoolean: () => confirm },
      reply: async (p) => replies.push(p),
    });
  await run(null);
  assert.match(
    replies[0].content,
    /Roles you bought in the shop \(temporary or permanent\) are taken off you first/
  );
  assert.equal(m.roles.cache.has(ROLE_T), true, 'asking does not delete');

  await run(true);
  assert.deepEqual(
    [m.roles.cache.has(ROLE_T), m.roles.cache.has(ROLE_P)],
    [false, false],
    'the roles are off'
  );
  assert.equal(await getTempRole(G, U, ROLE_T), null, 'the record is deleted');
  assert.equal((await listInventory(G, U)).length, 0);
  const field = replies[1].embeds[0].data.fields.find((f) => f.name === 'Shop roles taken off');
  assert.equal(field.value, '2 of 2');
});

test('/forget keeps the record of a temporary role Sylo could not take off, so the expiry still removes it', async () => {
  const { execute } = await import('../src/bot/commands/forget.js');
  const { getTempRole } = await import('../src/db/tempRoles.js');
  const ROLE_T = '700000000000000101';
  const g = fakeShopGuild(G, {
    roles: [{ id: ROLE_T, name: 'Temp', position: 1, managed: false, editable: true }],
  });
  ctx = g;
  const m = fakeMember(U);
  g.guild.members.cache.set(U, m);
  await credit(G, U, 1000, { kind: 'staff_add', config });
  const temp = await createItem(
    G,
    normaliseItem({ name: 'Temp', type: 'temp_role', roleId: ROLE_T, durationHours: 24, price: 100 })
  );
  await buyNow({ guild: g.guild, member: m, itemId: temp, config });
  g.guild.members.me.permissions.has = () => false; // Sylo lost Manage Roles meanwhile
  const replies = [];
  await execute({
    inGuild: () => true,
    guild: g.guild,
    guildId: G,
    user: m.user,
    options: { getBoolean: () => true },
    reply: async (p) => replies.push(p),
  });
  assert.equal(m.roles.cache.has(ROLE_T), true, 'could not be taken off');
  assert.ok(await getTempRole(G, U, ROLE_T), 'so the record stays and the sweep takes it back on time');
  assert.equal((await listInventory(G, U)).length, 0, 'the inventory is gone');
  const field = replies[0].embeds[0].data.fields.find((f) => f.name === 'Shop roles taken off');
  assert.match(field.value, /could not take off 1/);
});
