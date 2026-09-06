// Proves the driver shim's Postgres branch for the afk table — same
// assertions as afk.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'afk against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { getAfk, setAfk, clearAfk, clearGuildAfk } = await import('../src/db/afk.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-afk-${Date.now()}`;
    const U = '222222222222222222';

    await t.test('set / get / clear round-trip', async () => {
      assert.equal(await getAfk(G, U), null);
      await setAfk(G, U, { reason: 'lunch', oldNick: 'Bob' });
      const row = await getAfk(G, U);
      assert.equal(row.reason, 'lunch');
      assert.equal(row.old_nick, 'Bob');
      assert.ok(row.since > 0);
      await clearAfk(G, U);
      assert.equal(await getAfk(G, U), null);
    });

    await t.test('re-set upserts (ON CONFLICT DO UPDATE); oldNick null stores as null', async () => {
      await setAfk(G, U, { reason: 'first', oldNick: 'A' });
      await setAfk(G, U, { reason: 'second', oldNick: null });
      const row = await getAfk(G, U);
      assert.equal(row.reason, 'second');
      assert.equal(row.old_nick, null);
      await clearGuildAfk(G);
      assert.equal(await getAfk(G, U), null);
    });
  }
);
