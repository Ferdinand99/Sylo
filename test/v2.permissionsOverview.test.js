// Who may call the overview and the member lookups behind the dashboard's mentions: someone who does not
// manage the server, the admin of a different server and a signed-out caller are all refused. These routes
// have their own file because the permission tests of the other modules already use nearly all of the
// dashboard's request budget per minute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const READS = (g) => [
  `/guilds/${g}/overview`,
  `/guilds/${g}/members/search?q=al`,
  `/guilds/${g}/members/names?ids=100000000000000021`,
];

test('someone who does not manage the server is refused the overview and the member lookups', async () => {
  const nobody = await session({
    guilds: [
      { id: D_GUILD, owner: false, permissions: '0' },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });
  for (const path of READS(D_GUILD)) assert.equal((await nobody.get(path)).status, 403, `GET ${path}`);
});

test('the admin of one server is refused the overview and the member lookups of another', async () => {
  const admin = await session(); // owner of D_GUILD, no rights in OTHER_D_GUILD
  for (const path of READS(OTHER_D_GUILD)) assert.equal((await admin.get(path)).status, 403, `GET ${path}`);
});

test('the admin of the server gets the overview, with the attention data', async () => {
  const admin = await session();
  const res = await admin.get(`/guilds/${D_GUILD}/overview`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.groups));
  assert.deepEqual(Object.keys(body.attention).sort(), [
    'missingPermissions',
    'platform',
    'problems',
    'waiting',
    'waitingForOwner',
  ]);
  assert.ok(body.groups.flatMap((g) => g.cards).every((c) => Array.isArray(c.summaryParts)));
});

test('a signed-out caller is refused too', async () => {
  const nobody = anonymous();
  for (const path of READS(D_GUILD)) {
    const { status } = await nobody.get(path);
    assert.ok(status === 401 || status === 403, `GET ${path} -> ${status}`);
  }
});
