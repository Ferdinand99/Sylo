// Proves the driver shim's Postgres branch for appeals: a SERIAL surrogate PK
// read back via RETURNING id, a partial unique index (same CREATE UNIQUE INDEX
// ... WHERE syntax on both drivers), and — the part that actually needed a
// code change — cross-dialect detection of a unique-constraint violation.
// SQLite's error message is "UNIQUE constraint failed: …"; Postgres's is
// "duplicate key value violates unique constraint …" (code 23505). Neither
// driver's wording matches the other, so createAppeal() checks both.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'appeals against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { createAppeal, getOpenAppeal, getLatestAppeal, decideAppeal, listAppeals, countOpenAppeals } =
      await import('../src/db/appeals.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-appeals-${Date.now()}`;
    const U = '222222222222222222';

    await t.test('one open appeal per user (partial unique index), decide closes it', async () => {
      const answers = [{ q: 'Why?', a: 'Mistake' }];
      const id = await createAppeal(G, { userId: U, userTag: 'foo#0', banReason: 'spam', answers });
      assert.ok(Number.isInteger(id) && id > 0);

      // Second insert while one is open hits the partial unique index — must
      // come back as null (via isUniqueViolation), not throw.
      assert.equal(await createAppeal(G, { userId: U, answers }), null);
      assert.equal(await countOpenAppeals(G), 1);
      assert.equal((await getOpenAppeal(G, U)).id, id);

      assert.equal(await decideAppeal(G, id, { status: 'denied', decidedBy: 'mod', reason: 'no' }), true);
      assert.equal(await countOpenAppeals(G), 0);
      assert.equal(await getOpenAppeal(G, U), undefined);
      assert.equal((await getLatestAppeal(G, U)).status, 'denied');

      // Deciding an already-closed appeal is a no-op.
      assert.equal(await decideAppeal(G, id, { status: 'accepted', decidedBy: 'mod', reason: 'x' }), false);

      // A fresh appeal can now be opened (the earlier one is no longer 'open').
      const id2 = await createAppeal(G, { userId: U, answers });
      assert.ok(id2 > id);
      assert.equal((await listAppeals(G, 10)).length, 2);
    });
  }
);
