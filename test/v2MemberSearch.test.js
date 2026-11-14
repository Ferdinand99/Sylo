// GET /api/v2/guilds/:id/members?q= — the member search behind the Sylo app's member picker
// (and anything else that needs to pick a member by name): cached members by name, an exact id
// looked up live, never a bot, at most 25, and only for people who manage the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  memberFetches,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const realFetch = guild.members.fetch;

setProfiles();
const web = browser();
await signIn(web, 'discord');
const { accountId } = await findIdentity('discord', profiles.discord.id);
const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
const adminId = profiles.discord.id;

const app = browser();
const search = (q, guildId = D_GUILD, bearer = token) =>
  app.get(`/api/v2/guilds/${guildId}/members${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
const names = async (q) => (await (await search(q)).json()).members;

const ALICE = '100000000000000011';
const BOB = '100000000000000012';
const BOT = '100000000000000500';
const person = (id, displayName, username, bot = false) => ({
  id,
  displayName,
  user: { id, username, bot },
});

test.beforeEach(() => {
  // The caller manages the server (the app's access is checked live through the bot).
  guild.members.cache.set(adminId, {
    id: adminId,
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { cache: { hasAny: () => false } },
  });
  guild.members.cache.set(ALICE, person(ALICE, 'Alice Wonder', 'alice'));
  guild.members.cache.set(BOB, person(BOB, 'Bob', 'bobby'));
  guild.members.cache.set(BOT, person(BOT, 'Robot Bob', 'robotbob', true));
  guild.members.fetch = realFetch;
  memberFetches.length = 0;
});
test.afterEach(() => guild.members.cache.clear());

test('finds cached members by display name or username, in any case', async () => {
  assert.deepEqual(await names('wond'), [{ id: ALICE, name: 'Alice Wonder', username: 'alice' }]);
  assert.deepEqual(await names('BOBBY'), [{ id: BOB, name: 'Bob', username: 'bobby' }]);
  assert.deepEqual(await names('nobody'), []);
});

test('no text, or text that is not a string, finds nobody', async () => {
  assert.deepEqual(await names(undefined), []);
  assert.deepEqual(await names(''), []);
  assert.deepEqual(await names('   '), []);
  const res = await app.get(`/api/v2/guilds/${D_GUILD}/members?q=a&q=b`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual((await res.json()).members, []);
});

test('an exact id is found in the cache, or fetched live when it is not cached', async () => {
  assert.equal((await names(ALICE))[0].name, 'Alice Wonder');
  assert.deepEqual(memberFetches, [], 'a cached member needs no lookup');

  const LATE = '100000000000000099';
  guild.members.fetch = async (id) => {
    memberFetches.push(id);
    if (id === LATE) return person(LATE, 'Late Joiner', 'late');
    throw new Error('Unknown Member');
  };
  assert.deepEqual(await names(LATE), [{ id: LATE, name: 'Late Joiner', username: 'late' }]);
  assert.deepEqual(await names('100000000000000098'), [], 'an id of nobody finds nobody');
  assert.deepEqual(memberFetches, [LATE, '100000000000000098']);
});

test('an id of a member of another server finds nobody here', async () => {
  const other = runtime.clients.discord.guilds.cache.get(OTHER_D_GUILD);
  const STRANGER = '100000000000000777';
  other.members.cache.set(STRANGER, person(STRANGER, 'Stranger', 'stranger'));
  try {
    assert.deepEqual(await names(STRANGER), [], 'not in this server, so not found by id');
    assert.deepEqual(await names('stranger'), [], 'nor by name');
  } finally {
    other.members.cache.delete(STRANGER);
  }
});

test('bots are never returned, by name or by id', async () => {
  assert.deepEqual(
    (await names('bob')).map((m) => m.id),
    [BOB]
  );
  assert.deepEqual(await names(BOT), []);
});

test('at most 25 members', async () => {
  for (let i = 0; i < 40; i++) {
    const id = String(100000000001000n + BigInt(i)).padStart(18, '1');
    guild.members.cache.set(id, person(id, `Crowd ${i}`, `crowd${i}`));
  }
  assert.equal((await names('crowd')).length, 25);
});

test('a name is cut at 100 characters, so a huge query cannot do more work', async () => {
  assert.deepEqual(await names('x'.repeat(5000)), []);
});

test('the answer has the same shape as the Temporary roles search', async () => {
  const mine = await names('alice');
  const old = await (
    await app.get(`/api/v2/guilds/${D_GUILD}/modules/temp-roles/members?q=alice`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  assert.deepEqual(old.members, mine);
});

test('only people who manage the server may search', async () => {
  const other = await search('alice', OTHER_D_GUILD);
  assert.equal(other.status, 403);
  assert.match(other.headers.get('content-type'), /json/);
  assert.equal((await search('alice', D_GUILD, null)).status, 401);
  assert.equal((await search('alice', D_GUILD, 'sylo_nope')).status, 401);
  // The dashboard's cookie works too.
  const res = await web.get(`/api/v2/guilds/${D_GUILD}/members?q=alice`);
  assert.equal(res.status, 200);
});

test('a person who lost the right gets nothing (live access check)', async () => {
  guild.members.cache.set(adminId, {
    id: adminId,
    permissions: { has: () => false },
    roles: { cache: { hasAny: () => false } },
  });
  assert.equal((await search('alice')).status, 403);
});
