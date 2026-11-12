// Who may call the Applications routes of the dashboard: someone who does not manage the server, the admin of
// a different server and a signed-out caller are all refused, and nothing is stored. (A submission holds
// personal answers, so the list, the detail, a member's history and the export are staff-only too.) These
// routes have their own file because the permission tests of the other modules already use nearly all of the
// dashboard's request budget per minute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { SNOWFLAKE, anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { listAudit } = await import('../src/db/audit.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { listForms, listSubmissions } = await import('../src/db/applications.js');

const WRITES = (g) => [
  [`/guilds/${g}/modules/applications/config`, { retentionDays: 30 }],
  [`/guilds/${g}/applications/forms`, { name: 'Staff', questions: [{ label: 'Why?' }] }],
  [`/guilds/${g}/applications/forms/1`, { name: 'Staff', questions: [{ label: 'Why?' }] }],
  [`/guilds/${g}/applications/forms/1/delete`, {}],
  [`/guilds/${g}/applications/forms/reorder`, { ids: [1] }],
  [`/guilds/${g}/applications/panel/publish`, { channelId: SNOWFLAKE }],
  [`/guilds/${g}/applications/panel/unpublish`, {}],
  [`/guilds/${g}/applications/submissions/1/decide`, { action: 'accept' }],
  [`/guilds/${g}/applications/submissions/1/retry-roles`, {}],
  [`/guilds/${g}/applications/submissions/1/delete`, {}],
];
const READS = (g) => [
  `/guilds/${g}/modules/applications/config`,
  `/guilds/${g}/applications/submissions`,
  `/guilds/${g}/applications/submissions/1`,
  `/guilds/${g}/applications/members/${SNOWFLAKE}`,
  `/guilds/${g}/applications/export?formId=1&format=csv`,
];

async function assertUntouched(note) {
  for (const g of [D_GUILD, OTHER_D_GUILD]) {
    assert.deepEqual(await listAudit(g, 50), [], `${note}: no audit rows (${g})`);
    assert.deepEqual(
      await getGuildModule(g, 'applications').then((m) => m.config),
      {},
      `${note}: settings stay empty`
    );
    assert.deepEqual(await listForms(g), [], `${note}: no forms`);
    assert.equal((await listSubmissions({ guildId: g })).total, 0, `${note}: no submissions`);
  }
}

test('someone who does not manage the server is refused every Applications route', async () => {
  const guilds = [
    { id: D_GUILD, owner: false, permissions: '0' },
    { id: OTHER_D_GUILD, owner: false, permissions: '0' },
  ];
  const nobody = await session({ guilds });
  for (const [path, body] of WRITES(D_GUILD))
    assert.equal((await nobody.post(path, body)).status, 403, `POST ${path}`);
  for (const path of READS(D_GUILD)) assert.equal((await nobody.get(path)).status, 403, `GET ${path}`);
  await assertUntouched('non-admin');
});

test('the admin of one server is refused every Applications route of another server', async () => {
  const admin = await session(); // owner of D_GUILD, no rights in OTHER_D_GUILD
  for (const [path, body] of WRITES(OTHER_D_GUILD))
    assert.equal((await admin.post(path, body)).status, 403, `POST ${path}`);
  for (const path of READS(OTHER_D_GUILD)) assert.equal((await admin.get(path)).status, 403, `GET ${path}`);
  await assertUntouched('wrong server');
});

test('signed out, every Applications route answers with an error and stores nothing', async () => {
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
