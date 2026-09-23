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

test('GET /roadmap renders the public board without login', async () => {
  const res = await get('/roadmap');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Roadmap/);
});

test('GET /roadmap/admin is reachable in open mode (requireOwner passes through)', async () => {
  const res = await get('/roadmap/admin');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Roadmap admin/);
});

test('POST /roadmap/suggest in open mode 400s instead of crashing (no real user id to attribute)', async () => {
  const res = await post(app.base, '/roadmap/suggest', { title: 'Idea', description: 'desc' });
  assert.equal(res.status, 400);
});

test('POST /roadmap/:id/vote in open mode 400s the same way', async () => {
  const res = await post(app.base, '/roadmap/1/vote', {});
  assert.equal(res.status, 400);
});

test('POST /roadmap/admin (create) in open mode 400s the same way', async () => {
  const res = await post(app.base, '/roadmap/admin', { title: 'Idea', description: 'desc' });
  assert.equal(res.status, 400);
});
