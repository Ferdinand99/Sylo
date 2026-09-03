// Off-site backup shipping. No network: globalThis.fetch is stubbed. The env
// vars must be set before config.js is imported, so this file loads the module
// with a dynamic import after setting them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DISCORD_TOKEN ||= 'x';
process.env.DISCORD_CLIENT_ID ||= '000000000000000000';
process.env.BACKUP_WEBDAV_URL = 'https://dav.test/backups/';
process.env.BACKUP_WEBDAV_USER = 'me';
process.env.BACKUP_WEBDAV_PASS = 'pw';
process.env.BACKUP_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/tok';

const { shipOffsiteBackup, offsiteBackupConfigured, offsiteBackupStatus } =
  await import('../src/db/offsiteBackup.js');

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const snap = join(tmpdir(), `sylo-offsite-${process.pid}.db`);
test.before(() => writeFileSync(snap, Buffer.from(`SQLite format 3\0${'x'.repeat(4000)}`)));
test.after(() => rmSync(snap, { force: true }));

test('config helpers reflect the env', () => {
  assert.equal(offsiteBackupConfigured(), true);
  assert.equal(offsiteBackupStatus(), 'WebDAV + Discord webhook');
});

test('shipOffsiteBackup PUTs to WebDAV (basic auth) and POSTs to the webhook', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body });
    return { ok: true, status: 200 };
  };

  await shipOffsiteBackup(snap);
  assert.equal(calls.length, 2);

  const dav = calls.find((c) => c.method === 'PUT');
  assert.match(dav.url, /^https:\/\/dav\.test\/backups\/sylo-offsite-\d+\.db\.gz$/);
  assert.equal(dav.headers.authorization, `Basic ${Buffer.from('me:pw').toString('base64')}`);
  assert.ok(dav.body instanceof Uint8Array && dav.body.length > 0); // gzipped bytes

  const hook = calls.find((c) => c.method === 'POST');
  assert.equal(hook.url, 'https://discord.com/api/webhooks/1/tok');
  assert.ok(hook.body instanceof FormData);
});

test('a non-ok response is swallowed (never throws)', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 507 });
  await assert.doesNotReject(shipOffsiteBackup(snap));
});

test('a thrown fetch is swallowed', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.doesNotReject(shipOffsiteBackup(snap));
});

test('a missing source file is handled, not thrown', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  await assert.doesNotReject(shipOffsiteBackup(join(tmpdir(), 'does-not-exist-xyz.db')));
  assert.equal(called, false); // gzip read failed → nothing shipped
});
