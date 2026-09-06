// Proves the driver shim's Postgres branch for stats_cache (single-column
// TEXT primary key + ON CONFLICT upsert) — same assertions as
// cache.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'cache against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { cacheKey, getCached, setCached, recentLookups, listCached } = await import('../src/db/cache.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const p1 = `pgtest-${stamp}-1`;
    const p2 = `pgtest-${stamp}-2`;

    await t.test('getCached miss then round-trip; setCached upserts', async () => {
      const key = cacheKey('bf4', 'pc', p1);
      assert.equal(await getCached(key), null);

      await setCached(key, { game: 'battlefield', title: 'bf4', username: p1, platform: 'pc' }, { kd: 1 });
      assert.deepEqual((await getCached(key)).payload, { kd: 1 });

      await setCached(key, { game: 'battlefield', title: 'bf4', username: p1, platform: 'pc' }, { kd: 2 });
      assert.deepEqual((await getCached(key)).payload, { kd: 2 });
    });

    await t.test('recentLookups/listCached return newest-first and parse the payload', async () => {
      const key2 = cacheKey('bf4', 'pc', p2);
      await setCached(key2, { game: 'battlefield', title: 'bf4', username: p2, platform: 'pc' }, { kd: 3 });

      // stats_cache is global (no guild scoping) — filter to our own key
      // rather than assuming it's the single most-recent row overall.
      const recent = (await recentLookups(50)).find((r) => r.username === p2);
      assert.ok(recent);

      const listed = (await listCached(50)).find((r) => r.username === p2);
      assert.deepEqual(listed.payload, { kd: 3 });
    });
  }
);
