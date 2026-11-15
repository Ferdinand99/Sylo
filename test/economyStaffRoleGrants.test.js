// Money buys the shop's role items, so crediting a member is a grant of every role the shop sells:
// someone who could not hand a sold role out themselves (above their own rank, or with moderator
// permissions and no Manage Roles) may not add, set or reset cash, for themselves or anyone else.
// Taking money away stays open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { createItem } = await import('../src/db/economyShop.js');
const { getAccount } = await import('../src/db/economy.js');
const { normaliseItem } = await import('../src/modules/lib/economyConfig.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  editable: true,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000701', 'Regular', 1);
const HIGH = fakeRole('700000000000000702', 'Legend', 20);
const MOD = fakeRole('700000000000000703', 'Helper', 2, ['KickMembers']);

const TARGET = '800000000000000701';

// One sign-in per kind of person: the sign-in has its own rate limit.
const sessions = new Map();
async function signedIn(top, perms = ['ManageGuild']) {
  const key = `${top}|${perms}`;
  if (!sessions.has(key)) {
    setProfiles();
    const b = browser();
    await signIn(b, 'discord');
    sessions.set(key, {
      b,
      id: profiles.discord.id,
      token: (await (await b.get('/api/v2/csrf')).json()).token,
    });
  }
  const { b, id, token } = sessions.get(key);
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: { position: top }, cache: new Map() },
  });
  guild.members.cache.set(TARGET, {
    id: TARGET,
    displayName: 'Target',
    user: { id: TARGET, username: 'target', bot: false },
  });
  const post = (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/economy${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const adjust = (body) => post(`/members/${TARGET}/adjust`, body);
  adjust.toggle = (enabled) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/economy`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  adjust.post = post;
  return adjust;
}

const sell = (role, extra = {}) =>
  createItem(
    D_GUILD,
    normaliseItem({ name: `${role.name} pass`, price: 50, type: 'role', roleId: role.id, ...extra })
  );
const cash = async () => Number((await getAccount(D_GUILD, TARGET))?.cash ?? 0);

test.beforeEach(async () => {
  await purgeGuild(D_GUILD);
  for (const r of [LOW, HIGH, MOD]) guild.roles.cache.set(r.id, r);
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: {} });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
});

test('crediting cash is refused while the shop sells a role above the actor', async () => {
  await sell(HIGH);
  const adjust = await signedIn(10);
  const res = await adjust({ action: 'add', amount: 500 });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Legend is above or equal to your highest role/);
  assert.equal(await cash(), 0, 'nothing was credited');
  assert.equal((await adjust({ action: 'set', amount: 500 })).status, 403);
  assert.equal((await adjust({ action: 'reset-user' })).status, 403);
});

test('a sold role with moderator permissions needs Manage Roles', async () => {
  await sell(MOD);
  const adjust = await signedIn(10);
  const res = await adjust({ action: 'add', amount: 500 });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Manage Roles/);
  const withRoles = await signedIn(10, ['ManageGuild', 'ManageRoles']);
  assert.equal((await withRoles({ action: 'add', amount: 500 })).status, 200);
});

test('taking money away is not a grant', async () => {
  await sell(HIGH);
  const adjust = await signedIn(10);
  // Nothing to take yet: the refusal is "insufficient", not a role refusal.
  const res = await adjust({ action: 'remove', amount: 5 });
  assert.notEqual(res.status, 403);
});

test('a shop that only sells roles the actor could hand out, or none, stays open', async () => {
  const adjust = await signedIn(10);
  assert.equal((await adjust({ action: 'add', amount: 100 })).status, 200, 'no role items');
  await sell(LOW);
  assert.equal((await adjust({ action: 'add', amount: 100 })).status, 200, 'a role below the actor');
  assert.equal(await cash(), 200);
});

test('a role item that is paused, or not a role, does not count', async () => {
  await sell(HIGH, { enabled: false });
  await createItem(D_GUILD, normaliseItem({ name: 'Sticker', price: 5, type: 'custom' }));
  const adjust = await signedIn(10);
  assert.equal((await adjust({ action: 'add', amount: 100 })).status, 200);
});

test('the owner and Administrators may credit whatever the shop sells', async () => {
  await sell(HIGH);
  const adjust = await signedIn(10, ['Administrator']);
  assert.equal((await adjust({ action: 'add', amount: 100 })).status, 200);
});

test('the refusal says the shop is the reason', async () => {
  await sell(HIGH);
  const adjust = await signedIn(10);
  const { error } = await (await adjust({ action: 'add', amount: 5 })).json();
  assert.match(error, /The shop sells a role you can't hand out, so you can't add money/);
});

test('raising what members earn is refused while the shop sells a role above the actor', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: { workMin: 50, workMax: 150 } });
  await sell(HIGH);
  const adjust = await signedIn(10);
  const raised = await adjust.post('/config', { workMin: 50, workMax: 100000 });
  assert.equal(raised.status, 403);
  assert.match((await raised.json()).error, /raise what members earn/);
  const cooldown = await adjust.post('/config', { workMin: 50, workMax: 150, workCooldownMinutes: 1 });
  assert.equal(cooldown.status, 403, 'a shorter cooldown pays more');
  const start = await adjust.post('/config', { workMin: 50, workMax: 150, startingBalance: 1000000 });
  assert.equal(start.status, 403);
  assert.equal(
    (await adjust.post('/reset', { confirm: 'RESET' })).status,
    200,
    'no starting balance: nothing to fund'
  );
});

test('a starting balance makes the reset a credit, so it is refused too', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: { startingBalance: 500 } });
  await sell(HIGH);
  const adjust = await signedIn(10);
  const res = await adjust.post('/reset', { confirm: 'RESET' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /reset the economy/);
});

test('lowering income, or changing something else, stays open', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: { workMin: 50, workMax: 150 } });
  await sell(HIGH);
  const adjust = await signedIn(10);
  assert.equal(
    (await adjust.post('/config', { workMin: 10, workMax: 20, currencyName: 'gold' })).status,
    200
  );
  assert.equal(
    (await adjust.post('/config', { workMin: 10, workMax: 20, currencyName: 'silver' })).status,
    200
  );
});

test('raising income is open when the shop sells nothing the actor could not hand out', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: { workMin: 50, workMax: 150 } });
  await sell(LOW);
  const adjust = await signedIn(10);
  assert.equal((await adjust.post('/config', { workMin: 50, workMax: 100000 })).status, 200);
});

test('a module that is on with no saved settings is compared with the defaults, so unrelated saves stay open', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: {} });
  await sell(HIGH);
  const adjust = await signedIn(10);
  const res = await adjust.post('/config', { currencyName: 'gold' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: {} });
  assert.equal((await adjust.post('/config', { workMax: 100000 })).status, 403, 'a real raise is still refused');
});

test('switching the economy on is still refused while the shop sells a role above the actor', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: false, config: {} });
  await sell(HIGH);
  const adjust = await signedIn(10);
  const res = await adjust.toggle(true);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Switching .* on is refused.*someone whose highest role is above Legend/s);
});
