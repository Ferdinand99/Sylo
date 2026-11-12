// The money API against a transaction that holds an account, on a real Postgres connection (the order of
// the statements itself is checked without a database in economy.lockOrder.test.js; the stress test finds a
// wrong order only by luck). A raw transaction plays the other side:
//
// 1. It holds the lower account A while a call names A and the account B that does not exist yet, and then
//    makes B itself: the call waits for A before it creates B, so nothing is held in the wrong order and
//    both finish.
// 2. It deletes A (what /forget does) while the call waits for it: the call finishes with A made again.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'accounts are made and locked in id order: no deadlock with a transaction that holds a low id',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const postgres = (await import('postgres')).default;
    const eco = await import('../src/modules/lib/economy.js');
    const store = await import('../src/db/economy.js');
    const purge = await import('../src/db/purge.js');
    const { normaliseEconomyConfig } = await import('../src/modules/lib/economyConfig.js');
    const raw = postgres(url, { max: 1 });
    const admin = postgres(url, { max: 1 });
    const G = `locktest-${process.pid}-${Date.now()}`;
    const A = '8320000000000001';
    const B = '8320000000000002';
    const config = normaliseEconomyConfig({ startingBalance: 50 });
    t.after(async () => {
      await purge.purgeGuild(G);
      await raw.end({ timeout: 1 });
      await admin.end({ timeout: 1 });
      await closePostgres();
    });

    // wait until some other backend is blocked by the raw connection's transaction
    const waitUntilBlocked = async (blockerPid) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const [{ n }] = await admin`
          SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`;
        if (n > 0) return;
        assert.ok(Date.now() < deadline, 'the call never waited for the lock');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const insertAccount = (sql, id) => sql`
      INSERT INTO economy_accounts (guild_id, user_id, cash, bank, created_at, updated_at)
      VALUES (${G}, ${id}, 0, 0, 1, 1) ON CONFLICT (guild_id, user_id) DO NOTHING`;

    await t.test(
      'a call that is missing the higher account does not hold it while it waits for the lower',
      async () => {
        await eco.credit(G, A, 10, { kind: 'staff_add', config });
        let call;
        await raw.begin(async (tx) => {
          const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
          // the other side holds A ...
          await tx`UPDATE economy_accounts SET updated_at = updated_at WHERE guild_id = ${G} AND user_id = ${A}`;
          // ... while a transfer names A and the account B that does not exist yet
          call = eco.transfer(G, A, B, 1, { config });
          await waitUntilBlocked(pid);
          // ... and the other side then makes B too. With the old order the call already held B's new row.
          await insertAccount(tx, B);
        });
        const out = await call;
        assert.equal(out.ok, true);
        assert.equal((await store.getAccount(G, A)).cash, 59); // 50 start + 10 - 1
        assert.equal((await store.getAccount(G, B)).cash, 1);
      }
    );

    await t.test(
      'an account deleted while the call waits for it is made again, and the call finishes',
      async () => {
        const G2 = `${G}-vanish`;
        await eco.credit(G2, A, 10, { kind: 'staff_add', config });
        await eco.credit(G2, B, 10, { kind: 'staff_add', config });
        let call;
        await raw.begin(async (tx) => {
          const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
          // what /forget does: hold A and delete it
          await tx`DELETE FROM economy_accounts WHERE guild_id = ${G2} AND user_id = ${A}`;
          call = eco.transfer(G2, A, B, 3, { config });
          await waitUntilBlocked(pid);
        }); // commit: the call's lock finds no row
        const out = await call;
        // A was made again with the starting balance (50), so the payment of 3 goes through
        assert.equal(out.ok, true);
        assert.equal((await store.getAccount(G2, A)).cash, 47);
        assert.equal((await store.getAccount(G2, B)).cash, 63); // 50 start + 10 + 3
        await purge.purgeGuild(G2);
      }
    );
  }
);
