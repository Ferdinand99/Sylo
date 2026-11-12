// The web shop (/shop/<server>, /api/v2/shop/<server>): who may open it and who gets the one 404, what
// it shows, that buying goes through the same purchase() as /buy (ledger, stock, requirements checked
// on the server), CSRF, the buy rate limit, the address that sends you on, and Fluxer servers.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  F_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';
import { fakeMember, fakeRole } from './helpers/fakeShop.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { db } = await import('../src/db/index.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createItem, getItem } = await import('../src/db/economyShop.js');
const { getAccount } = await import('../src/db/economy.js');
const { credit } = await import('../src/modules/lib/economy.js');
const { normaliseItem } = await import('../src/modules/lib/economyConfig.js');

const { purgeGuild } = await import('../src/db/purge.js');

const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
const FKEY = `fluxer:${F_GUILD}`;
const ROLE_NEEDED = '700000000000000555';
const ROLE_GIVEN = '700000000000000556';
for (const g of [dGuild, fGuild]) {
  g.roles.cache.set(ROLE_NEEDED, fakeRole(ROLE_NEEDED, 'Supporter'));
  g.roles.cache.set(ROLE_GIVEN, fakeRole(ROLE_GIVEN, 'Millionaire'));
  g.members.me = {
    id: 'bot',
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 10 } },
  };
}

beforeEach(async () => {
  await purgeGuild(D_GUILD);
  await purgeGuild(`fluxer:${F_GUILD}`);
});

const ME = '300000000000000777'; // the signed-in Discord person of these tests
const FME = '400000000000000777'; // and their Fluxer identity
const memberOf = (guild, id, roles = []) => {
  const m = fakeMember(id, { roles });
  guild.members.cache.set(id, m);
  return m;
};
const enableShop = (key, config = {}) =>
  setGuildModule(key, 'economy', { enabled: true, config: { webShop: true, ...config } });
const mk = (key, over) =>
  createItem(key, normaliseItem({ name: 'Shout-out', price: 100, type: 'custom', ...over }));
const cashOf = async (key, id) => Number((await getAccount(key, id))?.cash ?? 0);

async function signedIn() {
  setProfiles({ discordId: ME });
  return session({ discordId: ME });
}
const view = (res) => res.json();

test('a signed-out visitor never reaches the shop, and a signed-in person who may not use it gets the one 404', async () => {
  await enableShop(D_GUILD);
  const anon = anonymous();
  const out = await anon.get(`/shop/${D_GUILD}`);
  assert.ok([401, 403].includes(out.status), `signed out: ${out.status}`);

  const me = await signedIn();
  // not a member of the server
  const stranger = await me.get(`/shop/${D_GUILD}`);
  assert.equal(stranger.status, 404);
  const body = await stranger.text();
  assert.deepEqual(JSON.parse(body), { error: 'Not found' });

  // a server Sylo does not know, and addresses that are no server at all: the very same answer
  for (const key of ['900000000000099999', 'not-a-server', 'fluxer:1']) {
    const res = await me.get(`/shop/${encodeURIComponent(key)}`);
    assert.equal(res.status, 404, key);
    assert.equal(await res.text(), body, `${key}: same body`);
  }
  assert.equal((await me.post(`/shop/${D_GUILD}/buy`, { itemId: 1 })).status, 404);
});

test('a member of a server whose module or web shop is off gets the same 404', async () => {
  const me = await signedIn();
  memberOf(dGuild, ME);
  const same = async () => {
    const res = await me.get(`/shop/${D_GUILD}`);
    return [res.status, await res.text()];
  };
  const never = await same(); // economy never switched on
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: {} }); // on, web shop off (the default)
  const noWeb = await same();
  await setGuildModule(D_GUILD, 'economy', { enabled: false, config: { webShop: true } }); // web shop on, module off
  const moduleOff = await same();
  for (const answer of [never, noWeb, moduleOff])
    assert.deepEqual(answer, [404, JSON.stringify({ error: 'Not found' })]);
  await enableShop(D_GUILD);
  assert.equal((await me.get(`/shop/${D_GUILD}`)).status, 200);
});

test('a member sees their balance, the items for sale (not the paused ones) and what they own', async () => {
  await enableShop(D_GUILD, { currencyName: 'gold', currencyEmoji: '💰' });
  const me = await signedIn();
  const m = memberOf(dGuild, ME);
  await credit(D_GUILD, ME, 250, { kind: 'staff_add' });
  const cheap = await mk(D_GUILD, { name: 'Cheap', price: 50, stock: 3, description: 'nice' });
  await mk(D_GUILD, { name: 'Dear', price: 900 });
  await mk(D_GUILD, { name: 'Hidden', enabled: false });
  await mk(D_GUILD, { name: 'VIP', requiredRoles: [ROLE_NEEDED] });
  const res = await me.get(`/shop/${D_GUILD}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const page = await view(res);
  assert.deepEqual(page.currency, { name: 'gold', emoji: '💰' });
  assert.deepEqual(page.balance, { cash: 250, bank: 0, total: 250 });
  assert.deepEqual(
    page.items.map((i) => i.name),
    ['Cheap', 'Dear', 'VIP']
  );
  const byName = Object.fromEntries(page.items.map((i) => [i.name, i]));
  assert.deepEqual([byName.Cheap.canBuy, byName.Cheap.left, byName.Cheap.description], [true, 3, 'nice']);
  assert.deepEqual([byName.Dear.canBuy, byName.Dear.problem], [false, 'Not enough cash.']);
  assert.equal(byName.VIP.canBuy, false);
  assert.match(byName.VIP.problem, /You need one of these roles to buy that: @Supporter/);
  assert.deepEqual(byName.VIP.requiredRoles, [{ id: ROLE_NEEDED, name: 'Supporter' }]);
  assert.deepEqual(page.inventory, []);

  // the same function as /buy: ledger, stock, inventory
  const buy = await me.post(`/shop/${D_GUILD}/buy`, { itemId: cheap });
  assert.equal(buy.status, 200);
  const out = await view(buy);
  assert.deepEqual(
    [
      out.ok,
      out.bought.name,
      out.view.balance.cash,
      out.view.inventory.length,
      out.view.items.find((i) => i.name === 'Cheap').left,
    ],
    [true, 'Cheap', 200, 1, 2]
  );
  assert.equal(await cashOf(D_GUILD, ME), 200);
  assert.equal((await getItem(D_GUILD, cheap)).sold, 1);
  const ledger = db
    .prepare(
      "SELECT kind, amount FROM economy_transactions WHERE guild_id = ? AND user_id = ? AND kind = 'purchase'"
    )
    .get(D_GUILD, ME);
  assert.deepEqual({ ...ledger }, { kind: 'purchase', amount: -50 });
  void m;
});

test('the requirements are checked on the server, not trusted from the page', async () => {
  await enableShop(D_GUILD);
  const me = await signedIn();
  memberOf(dGuild, ME);
  await credit(D_GUILD, ME, 1000, { kind: 'staff_add' });
  const vip = await mk(D_GUILD, { name: 'VIP', requiredRoles: [ROLE_NEEDED] });
  const paused = await mk(D_GUILD, { name: 'Paused', enabled: false });
  const soldOut = await mk(D_GUILD, { name: 'Gone', stock: 0 });
  const before = await cashOf(D_GUILD, ME);
  for (const [id, text] of [
    [vip, /need one of these roles .*@Supporter/],
    [paused, /not for sale/],
    [soldOut, /sold out/],
    [999999, /no longer in the shop/],
    ['junk', /no longer in the shop/],
  ]) {
    const res = await me.post(`/shop/${D_GUILD}/buy`, { itemId: id });
    assert.equal(res.status, 400);
    const body = await view(res);
    assert.match(body.error, text);
    assert.ok(body.view, 'the refusal carries a fresh view');
  }
  assert.equal(await cashOf(D_GUILD, ME), before, 'nothing was charged');
  // and with the role it works
  memberOf(dGuild, ME, [fakeRole(ROLE_NEEDED, 'Supporter')]);
  assert.equal((await me.post(`/shop/${D_GUILD}/buy`, { itemId: vip })).status, 200);
});

test('too little cash is refused with the price', async () => {
  await enableShop(D_GUILD);
  const me = await signedIn();
  memberOf(dGuild, ME);
  await credit(D_GUILD, ME, 10, { kind: 'staff_add' });
  const id = await mk(D_GUILD, { price: 100 });
  const res = await me.post(`/shop/${D_GUILD}/buy`, { itemId: id });
  assert.equal(res.status, 400);
  assert.match((await view(res)).error, /not have enough cash: it costs .*100/);
});

test('a role item is given in the platform, and a temporary role shows when it ends', async () => {
  await enableShop(D_GUILD);
  const me = await signedIn();
  const m = memberOf(dGuild, ME);
  await credit(D_GUILD, ME, 1000, { kind: 'staff_add' });
  const id = await mk(D_GUILD, {
    name: 'Millionaire',
    type: 'temp_role',
    roleId: ROLE_GIVEN,
    durationHours: 24,
    price: 100,
  });
  const res = await me.post(`/shop/${D_GUILD}/buy`, { itemId: id });
  assert.equal(res.status, 200);
  const out = await view(res);
  assert.deepEqual(m.adds, [ROLE_GIVEN]);
  assert.ok(out.bought.expiresAt > Date.now());
  assert.ok(out.view.inventory[0].expiresAt > Date.now());
});

test('buying needs the CSRF token, and a stranger cannot buy', async () => {
  await enableShop(D_GUILD);
  setProfiles({ discordId: ME });
  const b = browser();
  await signIn(b, 'discord');
  memberOf(dGuild, ME);
  await credit(D_GUILD, ME, 500, { kind: 'staff_add' });
  const id = await mk(D_GUILD, { price: 10 });
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  const noToken = await b.get(`/api/v2/shop/${D_GUILD}/buy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ itemId: id }),
  });
  assert.equal(noToken.status, 403);
  assert.equal(await cashOf(D_GUILD, ME), 500);
  const token = (await (await b.get('/api/v2/csrf', { headers })).json()).token;
  const ok = await b.get(`/api/v2/shop/${D_GUILD}/buy`, {
    method: 'POST',
    headers: { ...headers, 'x-csrf-token': token },
    body: JSON.stringify({ itemId: id }),
  });
  assert.equal(ok.status, 200);
  assert.equal(await cashOf(D_GUILD, ME), 490);

  // someone else, signed in but not a member of this server
  const other = await session({ discordId: '300000000000000888' });
  assert.equal((await other.post(`/shop/${D_GUILD}/buy`, { itemId: id })).status, 404);
  assert.equal((await getItem(D_GUILD, id)).sold, 1, 'only the member bought');
});

test('/shop/<server> sends a signed-in visitor on to the shop page, and a signed-out one to the login', async () => {
  const b = browser();
  const anon = await b.get(`/shop/${D_GUILD}`);
  assert.ok([301, 302, 303, 307].includes(anon.status));
  assert.match(anon.headers.get('location'), /login|auth/);
  setProfiles({ discordId: ME });
  await signIn(b, 'discord');
  const on = await b.get(`/shop/${D_GUILD}`, { headers: { accept: 'text/html' } });
  assert.equal(on.status, 302);
  assert.equal(on.headers.get('location'), `/v2/shop/${D_GUILD}`);
  const odd = await b.get('/shop/%2e%2e%2fadmin', { headers: { accept: 'text/html' } });
  assert.equal(odd.headers.get('location'), '/v2');
});

test('a Fluxer server works with the Fluxer login, and a Discord login is not looked up there', async () => {
  await enableShop(FKEY);
  setProfiles({ discordId: ME, fluxerId: FME });
  const b = browser();
  await signIn(b, 'fluxer');
  const token = (await (await b.get('/api/v2/csrf', { headers: { accept: 'application/json' } })).json())
    .token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  const url = `/api/v2/shop/${encodeURIComponent(FKEY)}`;

  assert.equal((await b.get(url, { headers })).status, 404, 'not a member yet');
  memberOf(fGuild, FME);
  await credit(FKEY, FME, 300, { kind: 'staff_add' });
  const id = await mk(FKEY, { price: 75 });
  const page = await (await b.get(url, { headers })).json();
  assert.equal(page.guild.id, FKEY);
  assert.equal(page.balance.cash, 300);
  const bought = await b.get(`${url}/buy`, { method: 'POST', headers, body: JSON.stringify({ itemId: id }) });
  assert.equal(bought.status, 200);
  assert.equal(await cashOf(FKEY, FME), 225);

  // a Discord-only person whose Discord id happens to be in the Fluxer member list is still refused
  memberOf(fGuild, ME);
  const discordOnly = await session({ discordId: ME });
  assert.equal((await discordOnly.get(`/shop/${encodeURIComponent(FKEY)}`)).status, 404);
  assert.equal(profiles.discord.id, ME);
});
