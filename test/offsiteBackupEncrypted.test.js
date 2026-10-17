// With BACKUP_ENCRYPTION_KEY set, the off-site copy is encrypted before it leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

process.env.DISCORD_TOKEN ||= 'x';
process.env.DISCORD_CLIENT_ID ||= '000000000000000000';
process.env.BACKUP_WEBDAV_URL = 'https://dav.test/backups/';
process.env.BACKUP_WEBDAV_USER = '';
process.env.BACKUP_WEBHOOK_URL = '';
process.env.BACKUP_ENCRYPTION_KEY = 'a long passphrase';

const { shipOffsiteBackup } = await import('../src/db/offsiteBackup.js');
const { decryptBackup } = await import('../src/lib/backupCrypto.js');

test('the shipped copy is encrypted and named .enc', async () => {
  const snap = join(tmpdir(), `sylo-offsite-enc-${process.pid}.db`);
  const original = Buffer.from(`SQLite format 3\0${'y'.repeat(2000)}`);
  writeFileSync(snap, original);
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts.body });
    return { ok: true, status: 200 };
  };
  try {
    await shipOffsiteBackup(snap);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(snap, { force: true });
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\.db\.gz\.enc$/);
  assert.deepEqual(gunzipSync(decryptBackup(Buffer.from(calls[0].body), 'a long passphrase')), original);
});
