// Proves the driver shim's Postgres branch for leveling.js — most
// importantly, that 50 concurrent addXp() calls for the *same* member never
// lose an increment (the atomic upsert-with-RETURNING redesign that replaced
// a better-sqlite3 db.transaction()-wrapped read-then-write), and that the
// table-qualified ON CONFLICT columns (leveling.xp, leveling_periods.xp, …)
// don't hit Postgres's "column reference is ambiguous" error the way an
// unqualified `xp = xp + excluded.xp` would (see inviteTracker.js's Phase 14
// incident for the same class of bug).
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';
import { levelFromXp } from '../src/modules/lib/levels.js';

const url = process.env.DATABASE_URL;

test(
  'leveling against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      addXp,
      setXp,
      getMember,
      topMembers,
      topMembersForPeriod,
      memberRank,
      memberCount,
      memberCountForPeriod,
      periodKeys,
      resetGuildLeveling,
    } = await import('../src/db/leveling.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-leveling-${Date.now()}`;
    const U1 = '210000000000000001';
    const U2 = '210000000000000002';

    await t.test('addXp: all-time row + both period rows, leveledUp/previousLevel', async () => {
      const now = Date.now();
      const first = await addXp(G, U1, 100, now);
      assert.equal(first.xp, 100);
      assert.equal(first.level, levelFromXp(100)); // 100 already crosses the level-1 threshold (100)
      assert.equal(first.leveledUp, true);
      assert.equal(first.previousLevel, 0);

      const second = await addXp(G, U1, 500, now);
      assert.equal(second.xp, 600);
      assert.equal(second.level, levelFromXp(600));
      assert.equal(second.leveledUp, second.level > levelFromXp(100));
      assert.equal(second.previousLevel, levelFromXp(100));

      const m = await getMember(G, U1);
      assert.equal(m.xp, 600);
      assert.equal(m.messages, 2);
      assert.equal(m.level, second.level);

      const { week, month } = periodKeys(now);
      const wRows = await topMembersForPeriod(G, week, 10);
      assert.equal(wRows.find((r) => r.user_id === U1)?.xp, 600);
      const moRows = await topMembersForPeriod(G, month, 10);
      assert.equal(moRows.find((r) => r.user_id === U1)?.xp, 600);
    });

    await t.test('voice XP: broken out from messages, minutes tracked', async () => {
      const g = `${G}-voice`;
      await addXp(g, U1, 30, Date.now(), { voice: true, minutes: 5 });
      const m = await getMember(g, U1);
      assert.equal(m.voice_xp, 30);
      assert.equal(m.voice_minutes, 5);
      assert.equal(m.messages, 0); // voice never bumps the message counter
    });

    await t.test('50 concurrent addXp calls for the same member never lose an increment', async () => {
      const g = `${G}-concurrent`;
      await Promise.all(Array.from({ length: 50 }, () => addXp(g, U1, 10, Date.now())));
      const m = await getMember(g, U1);
      assert.equal(m.xp, 500, 'all 50 increments of 10 must be reflected — none lost to a race');
      assert.equal(m.messages, 50);
      assert.equal(m.level, levelFromXp(500));
    });

    await t.test('setXp: overwrites xp/level, preserves messages/voice stats', async () => {
      const g = `${G}-setxp`;
      await addXp(g, U1, 20, Date.now());
      await addXp(g, U1, 15, Date.now(), { voice: true, minutes: 3 });
      const before = await getMember(g, U1);

      const xp = await setXp(g, U1, 9999);
      assert.equal(xp, 9999);
      const after = await getMember(g, U1);
      assert.equal(after.xp, 9999);
      assert.equal(after.messages, before.messages);
      assert.equal(after.voice_xp, before.voice_xp);
    });

    await t.test('topMembers / memberRank / memberCount / memberCountForPeriod', async () => {
      const g = `${G}-rank`;
      await addXp(g, U1, 300, Date.now());
      await addXp(g, U2, 100, Date.now());

      const top = await topMembers(g, 10);
      assert.deepEqual(
        top.map((r) => r.user_id),
        [U1, U2]
      );
      assert.equal(await memberRank(g, U1), 1);
      assert.equal(await memberRank(g, U2), 2);
      assert.equal(await memberCount(g), 2);

      const { week } = periodKeys();
      assert.equal(await memberCountForPeriod(g, week), 2);
    });

    await t.test('resetGuildLeveling wipes both tables', async () => {
      const g = `${G}-reset`;
      await addXp(g, U1, 50, Date.now());
      await resetGuildLeveling(g);
      assert.equal(await memberCount(g), 0);
      const { week } = periodKeys();
      assert.equal(await memberCountForPeriod(g, week), 0);
    });
  }
);
