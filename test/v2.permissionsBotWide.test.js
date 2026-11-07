// Signed-out callers, and who may call the bot-wide routes (personalizer, health, snapshots) of the
// new dashboard. The side effects themselves are in v2.guildAdmin.test.js; here each route is called
// by someone who must be refused and nothing may be stored. Per-server guards are in
// v2.permissions.test.js. The classic dashboard guards are removed with the classic dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import {
  BOT_WRITES,
  OPERATOR_ID,
  SERVER_READS,
  SERVER_WRITES,
  anonymous,
  session,
} from './helpers/v2Guarded.js';

await startOAuthApp();

const { listAudit } = await import('../src/db/audit.js');
const { listBotAudit } = await import('../src/db/botAudit.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { getAppeal, createAppeal } = await import('../src/db/appeals.js');
const { getPresenceConfig } = await import('../src/db/appSettings.js');
const { backupDir, listBackups, runBackup } = await import('../src/db/backup.js');

const KEEP = 'sylo-manual-keep.db';
let appealId;
test.before(async () => {
  appealId = await createAppeal(D_GUILD, { userId: '900000000000009999', userTag: 'u#1', answers: [] });
  // One known snapshot for the delete attempts.
  const { name } = await runBackup('manual');
  renameSync(join(backupDir(), name), join(backupDir(), KEEP));
});

/** Everything the refused calls must have left alone. */
async function assertUntouched(note) {
  assert.deepEqual(await listAudit(D_GUILD, 50), [], `${note}: no audit rows (${D_GUILD})`);
  assert.deepEqual(await listAudit(OTHER_D_GUILD, 50), [], `${note}: no audit rows (${OTHER_D_GUILD})`);
  assert.deepEqual(await listBotAudit(50), [], `${note}: no bot audit rows`);
  assert.equal((await getGuildModule(D_GUILD, 'afk')).enabled, false, `${note}: afk stays off`);
  assert.equal((await getAppeal(D_GUILD, appealId)).status, 'open', `${note}: the appeal stays open`);
  assert.notEqual((await getPresenceConfig()).text, 'hijacked', `${note}: presence unchanged`);
  assert.ok(existsSync(join(backupDir(), KEEP)), `${note}: the snapshot is still there`);
  assert.equal(listBackups().length, 1, `${note}: no snapshot was made`);
}

test('signed out: every route answers with an error, never with data, and stores nothing', async () => {
  const anon = anonymous();
  for (const [path, body] of [...SERVER_WRITES(D_GUILD), ...BOT_WRITES]) {
    const res = await anon.post(path, body);
    assert.ok([401, 403].includes(res.status), `POST ${path} -> ${res.status}`);
  }
  for (const path of [...SERVER_READS(D_GUILD), '/health', '/personalizer', '/personalizer/presence']) {
    const res = await anon.get(path);
    assert.ok([401, 403].includes(res.status), `GET ${path} -> ${res.status}`);
  }
  await assertUntouched('signed out');
});

test('a server admin who is not an operator is refused the bot-wide routes', async () => {
  const admin = await session();
  for (const [path, body] of BOT_WRITES) {
    assert.equal((await admin.post(path, body)).status, 403, `POST ${path}`);
  }
  for (const path of ['/health', '/personalizer', '/personalizer/presence', '/stats', '/dev-log']) {
    assert.equal((await admin.get(path)).status, 403, `GET ${path}`);
  }
  assert.equal((await admin.get(`/health/backups/${KEEP}`)).status, 403, 'the download is refused too');
  await assertUntouched('non-operator');
});

test('an operator reaches the bot-wide routes', async () => {
  const operator = await session({ discordId: OPERATOR_ID });
  const health = await operator.get('/health');
  assert.equal(health.status, 200);
  assert.ok((await health.json()).backups.some((b) => b.name === KEEP));
  assert.equal((await operator.get('/personalizer/presence')).status, 200);
  const presence = { status: 'online', type: 'Playing', text: 'ok' };
  assert.equal((await operator.post('/personalizer/presence', presence)).status, 200);
  assert.equal((await getPresenceConfig()).text, 'ok');

  const made = await operator.post('/health/backups');
  assert.equal(made.status, 200);
  const { name } = await made.json();
  assert.equal((await operator.post(`/health/backups/${name}/delete`)).status, 200);
  assert.ok(!existsSync(join(backupDir(), name)));
});
