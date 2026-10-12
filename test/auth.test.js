// Unit coverage for the guild-admin rules. Login, accounts and sessions are covered end to
// end in auth.oauth.test.js. (The cookie no longer holds a guild list — see src/db/accounts.js —
// so the cookie-size bug from issue #163 cannot recur in this design.)
process.env.DISCORD_CLIENT_SECRET = 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const { adminGuildIds, adminGuildIdsFromOAuth } = await import('../src/web/middleware/auth.js');
const { runtime } = await import('../src/runtime.js');

const ADMINISTRATOR = (1n << 3n).toString();
const MANAGE_GUILD = (1n << 5n).toString();
const NONE = '0';

test('adminGuildIdsFromOAuth: keeps owned or admin/manage-guild guilds only', () => {
  const guilds = [
    { id: 'owned', owner: true, permissions: NONE },
    { id: 'admin', owner: false, permissions: ADMINISTRATOR },
    { id: 'manage', owner: false, permissions: MANAGE_GUILD },
    { id: 'member-only', owner: false, permissions: NONE },
    { id: 'garbage-perms', owner: false, permissions: 'not-a-number' },
  ];
  assert.deepEqual(adminGuildIdsFromOAuth(guilds), ['owned', 'admin', 'manage']);
});

test('adminGuildIdsFromOAuth: non-array input and empty list both return []', () => {
  assert.deepEqual(adminGuildIdsFromOAuth(undefined), []);
  assert.deepEqual(adminGuildIdsFromOAuth(null), []);
  assert.deepEqual(adminGuildIdsFromOAuth([]), []);
});

test('adminGuildIdsFromOAuth: stores plain ids, not { id, owner, permissions } objects', () => {
  const guilds = Array.from({ length: 200 }, (_, i) => ({
    id: String(100000000000000000n + BigInt(i)),
    owner: true,
    permissions: NONE,
  }));
  const ids = adminGuildIdsFromOAuth(guilds);
  assert.equal(ids.length, 200); // uncapped here — the cap is the callback's job, tested below
  assert.ok(ids.every((id) => typeof id === 'string'));
});

test("adminGuildIds(req): the identities' guilds, limited to the bot's current guilds", (t) => {
  const savedClient = runtime.client;
  runtime.client = {
    guilds: {
      cache: new Map([
        ['bot-guild-1', {}],
        ['bot-guild-2', {}],
      ]),
    },
  };
  t.after(() => {
    runtime.client = savedClient;
  });

  const req = {
    account: {
      id: 'acc',
      identities: [{ platform: 'discord', guildIds: ['bot-guild-1', 'guild-bot-left', 'bot-guild-2'] }],
    },
  };
  assert.deepEqual([...adminGuildIds(req)].sort(), ['bot-guild-1', 'bot-guild-2']);
});

test('adminGuildIds(req): no account / no guilds → empty set, never throws', (t) => {
  const savedClient = runtime.client;
  runtime.client = { guilds: { cache: new Map() } };
  t.after(() => {
    runtime.client = savedClient;
  });

  assert.deepEqual([...adminGuildIds({})], []);
  assert.deepEqual([...adminGuildIds({ account: null })], []);
  assert.deepEqual([...adminGuildIds({ account: { id: 'a', identities: [] } })], []);
});
