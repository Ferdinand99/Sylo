// postgres.js hands BIGINT back as a string by default, but every BIGINT column in Sylo's
// schema is an epoch-ms timestamp or a counter that the code treats as a number (embed
// timestamps, arithmetic, comparisons). The connection converts them, so SQLite and
// Postgres return the same shapes.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'BIGINT columns come back as numbers',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { prepare } = await import('../src/db/driver.js');
    t.after(async () => {
      await closePostgres();
    });
    const row = await prepare('SELECT 1760000000000::bigint AS ts, COUNT(*) AS n FROM (SELECT 1) AS x').get();
    assert.strictEqual(typeof row.ts, 'number');
    assert.strictEqual(row.ts, 1_760_000_000_000);
    assert.strictEqual(typeof row.n, 'number');
  }
);
