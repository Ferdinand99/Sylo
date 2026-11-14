// A shop item that hands out a role is a role grant: the dashboard may only create it, edit it or give
// it to a member when the person using the dashboard could hand out that role themselves (below their
// highest role, Manage Roles for a role with elevated permissions). Otherwise anyone with Manage Server
// could make an item for a role above their own, fund themselves with the economy staff tools, buy the
// item and be given the role. These run with sign-in on, since open mode has no one to check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp, uid } from './helpers/oauthApp.js';
import { fakeMember as shopMember } from './helpers/fakeShop.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createItem, getItem, listItems } = await import('../src/db/economyShop.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { normaliseItem } = await import('../src/modules/lib/economyConfig.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  managed: false,
  editable: true,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000401', 'Regular', 1);
const MOD = fakeRole('700000000000000402', 'Mod', 3, ['KickMembers']);
const HIGH = fakeRole('700000000000000403', 'Legend', 20);

const TARGET = '800000000000000401';

/** The person using the dashboard: their top role and permissions, as the bot sees them. */
function fakeActor(id, top, perms = []) {
  return {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: { position: top }, cache: new Map() },
  };
}

async function signedIn(top, perms = ['ManageGuild']) {
  setProfiles({ discordId: uid('33333333333') });
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(id, fakeActor(id, top, perms));
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/economy/${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  return { id, post };
}

const roleItem = (roleId, extra = {}) => ({ name: 'Perk', price: 10, type: 'role', roleId, ...extra });
const names = async () => (await listItems(D_GUILD)).map((i) => i.name);

test.beforeEach(async () => {
  await purgeGuild(D_GUILD);
  for (const r of [LOW, MOD, HIGH]) guild.roles.cache.set(r.id, r);
  guild.members.me = {
    id: 'bot',
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 10 } },
  };
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: {} });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
});

test('creating an item for a role above your own is refused and nothing is saved', async () => {
  const { post } = await signedIn(10);
  const res = await post('shop/items', roleItem(HIGH.id));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Legend is above or equal to your highest role/);
  assert.deepEqual(await names(), []);
  // The same for a timed role.
  const timed = await post('shop/items', roleItem(HIGH.id, { type: 'temp_role', durationHours: 24 }));
  assert.equal(timed.status, 403);
  assert.deepEqual(await names(), []);
});

test('creating an item for a role at your own rank is refused, one below it is saved', async () => {
  const { post } = await signedIn(20);
  assert.equal((await post('shop/items', roleItem(HIGH.id))).status, 403, 'equal rank');
  assert.deepEqual(await names(), []);
  const ok = await post('shop/items', roleItem(LOW.id));
  assert.equal(ok.status, 200);
  assert.deepEqual(await names(), ['Perk']);
});

test('an item for a role with moderator permissions needs Manage Roles', async () => {
  const plain = await signedIn(10);
  const refused = await plain.post('shop/items', roleItem(MOD.id));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /need Manage Roles/);
  assert.deepEqual(await names(), []);
  const manager = await signedIn(10, ['ManageGuild', 'ManageRoles']);
  assert.equal((await manager.post('shop/items', roleItem(MOD.id))).status, 200);
});

test('an item that gives no role needs no check, and the server owner may use any role', async () => {
  const { post, id } = await signedIn(0, ['ManageGuild']);
  assert.equal((await post('shop/items', { name: 'Shout-out', price: 5, type: 'custom' })).status, 200);
  guild.ownerId = id;
  try {
    assert.equal((await post('shop/items', roleItem(HIGH.id, { name: 'Crown' }))).status, 200);
  } finally {
    guild.ownerId = 'x';
  }
  assert.deepEqual(await names(), ['Shout-out', 'Crown']);
});

test('editing an item so it gives a role above your own is refused and the item stays as it was', async () => {
  const id = await createItem(D_GUILD, normaliseItem({ name: 'Perk', price: 10, type: 'custom' }));
  const { post } = await signedIn(10);
  const res = await post(`shop/items/${id}`, roleItem(HIGH.id));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Legend is above/);
  const kept = await getItem(D_GUILD, id);
  assert.equal(kept.type, 'custom');
  assert.equal(kept.roleId ?? '', '');
  const ok = await post(`shop/items/${id}`, roleItem(LOW.id));
  assert.equal(ok.status, 200);
  assert.equal((await getItem(D_GUILD, id)).roleId, LOW.id);
});

test('giving a member an item with a role above your own is refused and gives nothing', async () => {
  const id = await createItem(
    D_GUILD,
    normaliseItem({ name: 'Crown', price: 10, type: 'role', roleId: HIGH.id })
  );
  const target = shopMember(TARGET);
  guild.members.cache.set(TARGET, target);
  const { post } = await signedIn(10);
  const res = await post(`members/${TARGET}/inventory/grant`, { itemId: id });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Legend is above/);
  assert.deepEqual(target.adds, [], 'the role was not put on the member');
});

test('giving a member an item with a role below you hands the role out', async () => {
  const id = await createItem(
    D_GUILD,
    normaliseItem({ name: 'Perk', price: 10, type: 'role', roleId: LOW.id })
  );
  const target = shopMember(TARGET);
  guild.members.cache.set(TARGET, target);
  const { post } = await signedIn(10);
  const res = await post(`members/${TARGET}/inventory/grant`, { itemId: id });
  assert.equal(res.status, 200);
  assert.deepEqual(target.adds, [LOW.id]);
});

test('a refused shop save leaves no unhandled rejection behind', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const { post } = await signedIn(10);
    for (let i = 0; i < 3; i++) assert.equal((await post('shop/items', roleItem(HIGH.id))).status, 403);
    await new Promise((resolve) => setTimeout(resolve, 50)); // unhandled rejections are reported on a later tick
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});
