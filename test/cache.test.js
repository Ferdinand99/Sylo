import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, getCached, setCached, recentLookups, listCached } from '../src/db/cache.js';

test('cacheKey lowercases the username, joins with :', () => {
  assert.equal(cacheKey('bf4', 'pc', 'SomePlayer'), 'bf4:pc:someplayer');
});

test('getCached is null for a miss; setCached + getCached round-trips the payload', async () => {
  const key = cacheKey('bf4', 'pc', 'player1');
  assert.equal(await getCached(key), null);

  await setCached(
    key,
    { game: 'battlefield', title: 'bf4', username: 'player1', platform: 'pc' },
    { kd: 1.5 }
  );
  const hit = await getCached(key);
  assert.deepEqual(hit.payload, { kd: 1.5 });
  assert.ok(hit.cachedAt <= Date.now());
});

test('setCached upserts — same key, new payload, still one entry', async () => {
  const key = cacheKey('bf4', 'pc', 'player2');
  await setCached(key, { game: 'battlefield', title: 'bf4', username: 'player2', platform: 'pc' }, { kd: 1 });
  await setCached(key, { game: 'battlefield', title: 'bf4', username: 'player2', platform: 'pc' }, { kd: 2 });
  const hit = await getCached(key);
  assert.deepEqual(hit.payload, { kd: 2 });
});

test('recentLookups and listCached return newest-first; listCached parses the payload', async () => {
  // stats_cache is a single global table (no guild scoping), shared with every
  // other test in this file — filter to these two keys rather than assuming
  // they land in the top N overall, since an upsert elsewhere can refresh
  // another row's created_at to roughly the same moment.
  const a = cacheKey('bf4', 'pc', 'recentA');
  const b = cacheKey('bf4', 'pc', 'recentB');
  await setCached(a, { game: 'battlefield', title: 'bf4', username: 'recentA', platform: 'pc' }, { kd: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await setCached(b, { game: 'battlefield', title: 'bf4', username: 'recentB', platform: 'pc' }, { kd: 2 });

  const recent = (await recentLookups(50)).filter(
    (r) => r.username === 'recentA' || r.username === 'recentB'
  );
  assert.deepEqual(
    recent.map((r) => r.username),
    ['recentB', 'recentA']
  );

  const listed = await listCached(50);
  const top = listed.find((r) => r.username === 'recentB');
  assert.deepEqual(top.payload, { kd: 2 });
});
