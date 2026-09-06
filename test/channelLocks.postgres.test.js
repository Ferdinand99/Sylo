// Proves the driver shim's Postgres branch for channel_locks (composite
// natural PK + ON CONFLICT upsert) — a subset of channelLocks.test.js's DB
// assertions, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'channelLocks against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      recordChannelLock,
      getChannelLock,
      isChannelLocked,
      clearChannelLock,
      guildChannelLocks,
      lockdownChannelLocks,
      clearGuildChannelLocks,
    } = await import('../src/db/channelLocks.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G = `pgtest-locks-${stamp}`;
    const C1 = '700000000000000001';
    const C2 = '700000000000000002';

    await t.test('round-trips, isChannelLocked, clear', async () => {
      await recordChannelLock({
        guildId: G,
        channelId: C1,
        prevAllow: 12345n,
        prevDeny: 0n,
        hadOverwrite: true,
        lockedBy: 'mod#1',
        lockdown: false,
      });

      assert.equal(await isChannelLocked(G, C1), true);
      const row = await getChannelLock(G, C1);
      assert.equal(row.prev_allow, '12345');
      assert.equal(row.had_overwrite, 1);
      assert.equal(row.lockdown, 0);

      assert.equal(await clearChannelLock(G, C1), 1);
      assert.equal(await isChannelLocked(G, C1), false);
    });

    await t.test('lockdownChannelLocks filters; upsert overwrites the same key', async () => {
      await recordChannelLock({ guildId: G, channelId: C1, lockedBy: 'm', lockdown: true });
      await recordChannelLock({ guildId: G, channelId: C2, lockedBy: 'm', lockdown: false });

      assert.deepEqual(
        (await lockdownChannelLocks(G)).map((r) => r.channel_id),
        [C1]
      );
      assert.equal((await guildChannelLocks(G)).length, 2);

      await recordChannelLock({ guildId: G, channelId: C1, lockedBy: 'm2', lockdown: false });
      const row = await getChannelLock(G, C1);
      assert.equal(row.locked_by, 'm2');
      assert.equal(row.lockdown, 0);

      await clearGuildChannelLocks(G);
      assert.equal((await guildChannelLocks(G)).length, 0);
    });
  }
);
