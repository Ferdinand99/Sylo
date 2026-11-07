// Who may call the new dashboard's per-server routes. The side effects themselves are in
// v2.moduleConfig, v2.moderation and v2.guildAdmin; here each route is called by someone who must
// be refused (a non-admin of the server, the admin of a different server) and nothing may be
// stored. Signed-out callers and the bot-wide routes are in v2.permissionsBotWide.test.js. The
// classic dashboard guard on the same routes is removed together with the classic dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { SERVER_READS, SERVER_WRITES, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { listAudit } = await import('../src/db/audit.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { listGithubWatches } = await import('../src/db/githubWatches.js');
const { getAppeal, createAppeal } = await import('../src/db/appeals.js');
const { getCommandOverride } = await import('../src/db/commandOverrides.js');

let appealId;
test.before(async () => {
  appealId = await createAppeal(D_GUILD, { userId: '900000000000009999', userTag: 'u#1', answers: [] });
});

/** Everything the refused calls must have left alone. */
async function assertUntouched(note) {
  for (const g of [D_GUILD, OTHER_D_GUILD]) {
    assert.deepEqual(await listAudit(g, 50), [], `${note}: no audit rows (${g})`);
    assert.equal((await getGuildModule(g, 'afk')).enabled, false, `${note}: afk stays off`);
    assert.deepEqual((await getGuildModule(g, 'welcome')).config, {}, `${note}: welcome stays empty`);
    assert.deepEqual(await listGithubWatches(g), [], `${note}: no github watches`);
    assert.equal(await getCommandOverride(g, 'ping'), null, `${note}: no command override`);
  }
  assert.equal((await getAppeal(D_GUILD, appealId)).status, 'open', `${note}: the appeal stays open`);
}

test('someone who does not manage the server is refused every server route', async () => {
  const guilds = [
    { id: D_GUILD, owner: false, permissions: '0' },
    { id: OTHER_D_GUILD, owner: false, permissions: '0' },
  ];
  const nobody = await session({ guilds });
  for (const [path, body] of SERVER_WRITES(D_GUILD)) {
    assert.equal((await nobody.post(path, body)).status, 403, `POST ${path}`);
  }
  for (const path of SERVER_READS(D_GUILD)) {
    assert.equal((await nobody.get(path)).status, 403, `GET ${path}`);
  }
  await assertUntouched('non-admin');
});

test('the admin of one server is refused every route of another server', async () => {
  const admin = await session(); // owner of D_GUILD, no rights in OTHER_D_GUILD
  for (const [path, body] of SERVER_WRITES(OTHER_D_GUILD)) {
    assert.equal((await admin.post(path, body)).status, 403, `POST ${path}`);
  }
  for (const path of SERVER_READS(OTHER_D_GUILD)) {
    assert.equal((await admin.get(path)).status, 403, `GET ${path}`);
  }
  await assertUntouched('wrong server');
});
