// Who may call the Economy page's routes: nobody who does not manage the server (and nobody signed
// out) may read the member list or change anyone's money, and the admin of one server may not touch
// another's. Kept apart from v2.permissions.test.js, which sits close to the dashboard's request
// limit (120 a minute) with the routes it already lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { SNOWFLAKE, anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { listAudit } = await import('../src/db/audit.js');
const { getAccount } = await import('../src/db/economy.js');
const { getGuildModule } = await import('../src/db/modules.js');

const WRITES = (g) => [
  [`/guilds/${g}/modules/economy/config`, { currencyName: 'hijacked' }],
  [`/guilds/${g}/modules/economy/members/${SNOWFLAKE}/adjust`, { action: 'add', amount: 5 }],
  [`/guilds/${g}/modules/economy/reset`, { confirm: 'RESET' }],
];
const READS = (g) => [
  `/guilds/${g}/modules/economy/config`,
  `/guilds/${g}/modules/economy/members`,
  `/guilds/${g}/modules/economy/members?q=a`,
  `/guilds/${g}/modules/economy/members/${SNOWFLAKE}`,
];

async function assertUntouched(note) {
  for (const g of [D_GUILD, OTHER_D_GUILD]) {
    assert.deepEqual(await listAudit(g, 50), [], `${note}: no audit rows (${g})`);
    assert.deepEqual((await getGuildModule(g, 'economy')).config, {}, `${note}: settings stay empty`);
    assert.equal(await getAccount(g, SNOWFLAKE), null, `${note}: no account was opened`);
  }
}

test('someone who does not manage the server is refused every economy route', async () => {
  const nobody = await session({
    guilds: [
      { id: D_GUILD, owner: false, permissions: '0' },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });
  for (const [path, body] of WRITES(D_GUILD))
    assert.equal((await nobody.post(path, body)).status, 403, `POST ${path}`);
  for (const path of READS(D_GUILD)) assert.equal((await nobody.get(path)).status, 403, `GET ${path}`);
  await assertUntouched('non-admin');
});

test('the admin of one server is refused every economy route of another server', async () => {
  const admin = await session(); // owner of D_GUILD, no rights in OTHER_D_GUILD
  for (const [path, body] of WRITES(OTHER_D_GUILD))
    assert.equal((await admin.post(path, body)).status, 403, `POST ${path}`);
  for (const path of READS(OTHER_D_GUILD)) assert.equal((await admin.get(path)).status, 403, `GET ${path}`);
  await assertUntouched('wrong server');
});

test('signed out: every economy route answers with an error and stores nothing', async () => {
  const anon = anonymous();
  for (const [path, body] of WRITES(D_GUILD)) {
    const res = await anon.post(path, body);
    assert.ok([401, 403].includes(res.status), `POST ${path} -> ${res.status}`);
  }
  for (const path of READS(D_GUILD)) {
    const res = await anon.get(path);
    assert.ok([401, 403].includes(res.status), `GET ${path} -> ${res.status}`);
  }
  await assertUntouched('signed out');
});

test('a server admin can use the routes: the member list answers, and a change is stored', async () => {
  const admin = await session();
  assert.equal((await admin.get(`/guilds/${D_GUILD}/modules/economy/members`)).status, 200);
  const saved = await admin.post(`/guilds/${D_GUILD}/modules/economy/config`, { currencyName: 'gold' });
  assert.equal(saved.status, 200);
  assert.equal((await getGuildModule(D_GUILD, 'economy')).config.currencyName, 'gold');
});
