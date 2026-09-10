// Proves the driver shim's Postgres branch for counting_penalties (composite
// (guild_id, user_id) primary key + ON CONFLICT upsert + a range scan on
// restore_at) — same shape as countingPenalties.test.js, real Postgres under it.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'counting_penalties against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      addCountingPenalty,
      getCountingPenalty,
      clearCountingPenalty,
      listCountingPenalties,
      dueCountingPenalties,
      clearGuildCountingPenalties,
    } = await import('../src/db/countingPenalties.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-cp-${Date.now()}`;
    const U1 = '800000000000000401';
    const U2 = '800000000000000402';
    const ROLE = '700000000000000001';

    await t.test('upsert, due filter, per-member and per-guild clears', async () => {
      await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 1000 });
      await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 5000 }); // overwrite
      assert.equal(Number((await getCountingPenalty(G, U1)).restore_at), 5000);
      assert.equal((await listCountingPenalties(G)).length, 1);

      await addCountingPenalty({ guildId: G, userId: U2, roleId: ROLE, restoreAt: 9_999_999_999_999 });
      const due = await dueCountingPenalties(6000);
      assert.deepEqual(
        due.map((r) => r.user_id),
        [U1]
      );

      await clearCountingPenalty(G, U1);
      assert.equal(await getCountingPenalty(G, U1), null);

      await clearGuildCountingPenalties(G);
      assert.equal((await listCountingPenalties(G)).length, 0);
    });
  }
);
