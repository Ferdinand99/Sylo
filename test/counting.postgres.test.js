// Proves the driver shim's Postgres branch for counting (single-column TEXT
// primary key + ON CONFLICT upsert) — same assertions as counting.test.js,
// real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'counting against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { getCounting, advanceCount, resetCount, setCount } = await import('../src/db/counting.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-counting-${Date.now()}`;
    const U1 = '800000000000000301';

    await t.test('defaults, advanceCount tracks record, resetCount keeps it', async () => {
      const zero = await getCounting(G);
      assert.equal(zero.current, 0);
      assert.equal(zero.record, 0);

      await advanceCount(G, { current: 1, userId: U1, messageId: 'm1' });
      await advanceCount(G, { current: 5, userId: U1, messageId: 'm2' });
      let st = await getCounting(G);
      assert.equal(st.current, 5);
      assert.equal(st.record, 5);

      await advanceCount(G, { current: 1, userId: U1, messageId: 'm3' }); // fail, restart at 1
      st = await getCounting(G);
      assert.equal(st.current, 1);
      assert.equal(st.record, 5);

      await resetCount(G);
      st = await getCounting(G);
      assert.equal(st.current, 0);
      assert.equal(st.record, 5);
      assert.equal(st.last_user_id, null);
    });

    await t.test('setCount forces a value, clamps invalid input, never drops the record', async () => {
      const n = await setCount(G, 42);
      assert.equal(n, 42);
      let st = await getCounting(G);
      assert.equal(st.current, 42);
      assert.equal(st.record, 42);

      assert.equal(await setCount(G, -5), 0);
      assert.equal(await setCount(G, 'nope'), 0);
      st = await getCounting(G);
      assert.equal(st.current, 0);
      assert.equal(st.record, 42);
    });
  }
);
