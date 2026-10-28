// Open mode (no login configured): the new dashboard's public endpoints answer, and the pages
// behind them keep working. Nobody can log in there, so the roadmap says voting is unavailable.
import { startWebApp } from './helpers/webApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v2Build } from '../src/web/routes/v2Client.js';

let app;
test.before(async () => {
  app = await startWebApp();
  const stubIndex = join(mkdtempSync(join(tmpdir(), 'sylo-v2-open-')), 'index.html');
  writeFileSync(stubIndex, '<!doctype html><title>stub shell</title>');
  v2Build.exists = () => true;
  v2Build.indexHtml = stubIndex;
});
test.after(() => app.close());

const get = (p) => fetch(app.base + p, { redirect: 'manual', headers: { accept: 'application/json' } });

test('the public pages and every other page are served in open mode', async () => {
  for (const path of ['/v2/commands', '/v2/roadmap', '/v2/', '/v2/account', '/v2/roadmap/admin']) {
    const res = await fetch(app.base + path, { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(res.status, 200, path);
  }
});

test('/api/v2/public/session says it is open mode', async () => {
  assert.deepEqual(await (await get('/api/v2/public/session')).json(), { signedIn: false, open: true });
});

test('/api/v2/public/roadmap answers in open mode, without a signed-in person', async () => {
  const res = await get('/api/v2/public/roadmap');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.signedIn, false);
  assert.equal(body.open, true);
  assert.equal(body.isOwner, false);
  assert.deepEqual(body.groups, { planned: [], started: [], completed: [] });
});

test('/api/v2/public/commands answers in open mode', async () => {
  app.client.commands = new Map();
  const res = await get('/api/v2/public/commands');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { commands: [] });
});
