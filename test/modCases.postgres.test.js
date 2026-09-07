// Proves the driver shim's Postgres branch for modCases.js — most
// importantly, that the atomic `INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING` case-number claim (which replaced a better-sqlite3
// `db.transaction()`-wrapped `SELECT MAX(case_number)+1`) is genuinely
// race-free under real concurrent writers, not just sequential ones.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'modCases against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      addCase,
      getCase,
      listUserCases,
      listGuildCases,
      editCaseReason,
      deactivateLatest,
      addWarning,
      clearWarnings,
      removeWarning,
    } = await import('../src/db/modCases.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-modcases-${Date.now()}`;
    const U = '110000000000000001';

    await t.test('addCase: sequential numbering, warnCount, getCase', async () => {
      const a = await addCase({ guildId: G, userId: U, moderatorId: 'm1', action: 'warn', reason: 'one' });
      const b = await addCase({ guildId: G, userId: U, moderatorId: 'm1', action: 'kick', reason: 'two' });
      assert.equal(a.caseNumber, 1);
      assert.equal(b.caseNumber, 2);
      assert.equal(b.warnCount, 1); // only #1 is a warn
      assert.equal((await getCase(G, 2)).action, 'kick');
      assert.equal(await getCase(G, 99), null);
    });

    await t.test('addCase: 25 concurrent claims for the same guild never collide', async () => {
      const g = `${G}-concurrent`;
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'note', reason: `n${i}` })
        )
      );
      const numbers = results.map((r) => r.caseNumber).sort((x, y) => x - y);
      assert.equal(new Set(numbers).size, 25, 'every claimed case number must be unique');
      assert.deepEqual(
        numbers,
        Array.from({ length: 25 }, (_, i) => i + 1),
        'claimed numbers must be exactly 1..25 with no gaps or duplicates'
      );
      const { total } = await listGuildCases(g, 100);
      assert.equal(total, 25);
    });

    await t.test(
      'listUserCases / listGuildCases / editCaseReason / setCaseActive / deactivateLatest',
      async () => {
        const g = `${G}-crud`;
        await addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban', reason: 'orig' }); // #1
        await addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban', reason: 'b' }); // #2

        assert.equal(await editCaseReason(g, 1, 'edited'), true);
        assert.equal((await getCase(g, 1)).reason, 'edited');
        assert.equal(await editCaseReason(g, 99, 'x'), false);

        const n = await deactivateLatest(g, U, 'ban');
        assert.equal(n, 2);
        assert.equal((await getCase(g, 2)).active, 0);
        assert.equal(await deactivateLatest(g, U, 'timeout'), null);

        const { rows, total } = await listUserCases(g, U, { limit: 10 });
        assert.equal(total, 1); // #2 is now inactive, excluded by default
        assert.equal(rows[0].case_number, 1);

        const withInactive = await listUserCases(g, U, { limit: 10, includeInactive: true });
        assert.equal(withInactive.total, 2);
      }
    );

    await t.test('warning wrappers stay compatible', async () => {
      const g = `${G}-warn`;
      const w1 = await addWarning({ guildId: g, userId: U, moderatorId: 'm', reason: 'a' });
      const w2 = await addWarning({ guildId: g, userId: U, moderatorId: 'm', reason: 'b' });
      assert.deepEqual([w1.id, w1.count], [1, 1]);
      assert.deepEqual([w2.id, w2.count], [2, 2]);
      assert.equal(await removeWarning(g, 1), true);
      assert.equal(await getCase(g, 1), null);
      assert.equal(await clearWarnings(g, U), 1);
    });
  }
);
