// The stored dev log: what the Sylo app's Health page shows, also without a dev-log channel and
// across restarts. Newest first, filterable by level, and bounded (500 entries, 30 days).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDevLogEntry, listDevLogEntries, pruneDevLog, DEV_LOG_KEEP } from '../src/db/devLogEntries.js';

const DAY = 86_400_000;

test('entries come back newest first, and can be limited to errors', async () => {
  const t = Date.now();
  await addDevLogEntry({ level: 'warn', scope: 'push', message: 'slow', at: t - 2000 });
  await addDevLogEntry({ level: 'error', scope: 'db', message: 'gone', at: t - 1000 });
  const all = await listDevLogEntries({ limit: 10 });
  assert.deepEqual(
    all.slice(0, 2).map((e) => [e.level, e.scope, e.message]),
    [
      ['error', 'db', 'gone'],
      ['warn', 'push', 'slow'],
    ]
  );
  assert.equal(typeof all[0].id, 'number');
  assert.equal(all[0].at, t - 1000);
  const errors = await listDevLogEntries({ limit: 10, level: 'error' });
  assert.ok(errors.every((e) => e.level === 'error'));
});

test('a long message is cut, so one entry cannot fill the database', async () => {
  await addDevLogEntry({ level: 'error', scope: 'x', message: 'y'.repeat(20_000), at: Date.now() });
  const [latest] = await listDevLogEntries({ limit: 1 });
  assert.ok(latest.message.length <= 4000);
});

test('pruning keeps the newest entries and drops old ones', async () => {
  const t = Date.now();
  await addDevLogEntry({ level: 'error', scope: 'old', message: 'ancient', at: t - 31 * DAY });
  for (let i = 0; i < DEV_LOG_KEEP + 20; i++) {
    await addDevLogEntry({ level: 'warn', scope: 's', message: `m${i}`, at: t + i });
  }
  await pruneDevLog(t + 1000);
  const left = await listDevLogEntries({ limit: 10_000 });
  assert.equal(left.length, DEV_LOG_KEEP);
  assert.ok(!left.some((e) => e.scope === 'old'));
  assert.equal(left[0].message, `m${DEV_LOG_KEEP + 19}`);
});
