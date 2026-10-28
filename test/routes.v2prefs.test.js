import { startWebApp } from './helpers/webApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Open mode has no signed-in user (currentUser().id is null), so the per-account
// dashboard-version preference must fall back to one shared "local admin" record
// rather than crash — the V2 dashboard asks for it on every page load.
let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const json = (path, init) => fetch(app.base + path, { redirect: 'manual', ...init });

test('GET /api/v2/prefs works in open mode', async () => {
  const res = await json('/api/v2/prefs');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dashboardVersion: 'v1' });
});

test('POST /api/v2/prefs stores the choice for the local admin', async () => {
  const set = await json('/api/v2/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dashboardVersion: 'v2' }),
  });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { dashboardVersion: 'v2' });
  assert.deepEqual(await (await json('/api/v2/prefs')).json(), { dashboardVersion: 'v2' });
});
