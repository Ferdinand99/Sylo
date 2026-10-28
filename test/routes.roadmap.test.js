import { startWebApp, post } from './helpers/webApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (p, headers) => fetch(app.base + p, { headers, redirect: 'manual' });

test('GET /roadmap/posts.json is public and starts empty', async () => {
  const res = await get('/roadmap/posts.json');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /roadmap is a permanent redirect to the dashboard board, whatever the Accept header says', async () => {
  const res = await get('/roadmap');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/v2/roadmap');
  const admin = await get('/roadmap/admin');
  assert.equal(admin.status, 301);
  assert.equal(admin.headers.get('location'), '/v2/roadmap/admin');
  assert.equal((await get('/roadmap', { accept: 'application/json' })).status, 301);
});

test('the classic roadmap vote, suggest and admin routes are gone', async () => {
  assert.equal(
    (await post(app.base, '/roadmap/suggest', { title: 'Idea', description: 'desc' })).status,
    404
  );
  assert.equal((await post(app.base, '/roadmap/1/vote', {})).status, 404);
  assert.equal((await post(app.base, '/roadmap/admin', { title: 'Idea', description: 'desc' })).status, 404);
});

// --- V2 API (src/web/routes/v2Api.js, the "Roadmap" section) -------------------------

test('GET /api/v2/roadmap is public JSON and starts with empty groups', async () => {
  const res = await get('/api/v2/roadmap');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.groups, { planned: [], started: [], completed: [] });
  assert.deepEqual(body.mine, []);
  assert.equal(body.isOwner, false);
});

test('GET /api/v2/roadmap/admin is reachable in open mode (requireOwner passes through)', async () => {
  const res = await get('/api/v2/roadmap/admin');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.pending, []);
  assert.deepEqual(body.statuses, ['planned', 'started', 'completed']);
});

test('POST /api/v2/roadmap/suggest in open mode 400s (no real user id to attribute)', async () => {
  const res = await post(app.base, '/api/v2/roadmap/suggest', { title: 'Idea', description: 'desc' });
  assert.equal(res.status, 400);
});

test('POST /api/v2/roadmap/:id/vote in open mode 400s the same way', async () => {
  const res = await post(app.base, '/api/v2/roadmap/1/vote', {});
  assert.equal(res.status, 400);
});

test('POST /api/v2/roadmap/admin (create) in open mode 400s the same way', async () => {
  const res = await post(app.base, '/api/v2/roadmap/admin', { title: 'Idea', description: 'desc' });
  assert.equal(res.status, 400);
});
