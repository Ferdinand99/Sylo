// The two things the new dashboard used to borrow from the classic one: the welcome image preview
// (a PNG for a server admin) and the database snapshot download (a file for the operator).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { backupDir } = await import('../src/db/backup.js');
const { welcomeCardAvailable } = await import('../src/bot/lib/welcomeCard.js');

const OPERATOR_ID = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js

/** Signed in as an admin of D_GUILD (not an operator unless `discordId` is one). */
async function session({ discordId } = {}) {
  setProfiles({ discordId });
  const b = browser();
  await signIn(b, 'discord');
  return b;
}

test('the welcome preview is a PNG for a server admin', async () => {
  const b = await session();
  const res = await b.get(`/api/v2/guilds/${D_GUILD}/modules/welcome/card-preview?v=1`);
  if (!welcomeCardAvailable) {
    assert.equal(res.status, 204); // no canvas on this host: the classic route answers the same
    return;
  }
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/png/);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=60');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('the welcome preview is refused for someone who does not manage the server', async () => {
  const b = await session();
  const res = await b.get(`/api/v2/guilds/${OTHER_D_GUILD}/modules/welcome/card-preview`);
  assert.equal(res.status, 403);
});

test('the operator downloads a snapshot as an attachment', async () => {
  const name = 'sylo-manual-v2fallback.db';
  writeFileSync(join(backupDir(), name), 'snapshot-bytes');
  const b = await session({ discordId: OPERATOR_ID });
  const res = await b.get(`/api/v2/health/backups/${name}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${name}"`);
  assert.match(res.headers.get('content-type'), /^application\/octet-stream/);
  assert.equal(await res.text(), 'snapshot-bytes');
});

test('a snapshot download is for operators only', async () => {
  const name = 'sylo-manual-v2fallback-denied.db';
  writeFileSync(join(backupDir(), name), 'secret');
  const b = await session();
  const res = await b.get(`/api/v2/health/backups/${name}`);
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /secret/);
});

test('a snapshot download refuses names that are not snapshot file names', async () => {
  const b = await session({ discordId: OPERATOR_ID });
  for (const bad of ['notes.txt', 'sylo-x.exe', '..%2F..%2Fetc%2Fpasswd', 'sylo-%2e%2e%2Fx.db']) {
    const res = await b.get(`/api/v2/health/backups/${bad}`);
    assert.equal(res.status, 400, bad);
  }
});

test('a well-formed snapshot name that does not exist is a 404', async () => {
  const b = await session({ discordId: OPERATOR_ID });
  const res = await b.get('/api/v2/health/backups/sylo-manual-nope.db');
  assert.equal(res.status, 404);
});
