// Regression test: runStatsLookup's cache-hit path must actually await
// getCached() — a real bug shipped once (missed in the commandOverrides +
// cache Postgres-driver-shim PR) where the call site kept the pre-await
// shape, so `hit` was a pending Promise (always truthy) and `hit.payload`
// was undefined, crashing every /stats call downstream at `stats.kd`. This
// wasn't caught by the existing cache.js DB-layer tests since none of them
// exercised the command's own lookup/caching logic end-to-end.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, setCached } from '../src/db/cache.js';
import { runStatsLookup } from '../src/bot/commands/stats.js';

test('runStatsLookup: a cache hit returns the real payload object, not a pending promise', async () => {
  const title = 'bf4';
  const platform = 'pc';
  const username = 'regressionPlayer';
  const key = cacheKey(title, platform, username);
  const payload = { username, kd: 1.23, winRate: 55 };

  await setCached(key, { game: 'battlefield', title, username, platform }, payload);

  const result = await runStatsLookup('battlefield', title, username, platform);
  assert.equal(result.cached, true);
  assert.deepEqual(result.stats, payload);
  assert.equal(result.stats.kd, 1.23);
});
