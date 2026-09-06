// Proves the driver shim's Postgres branch for starboard_posts (composite
// natural PK + an ON CONFLICT upsert with a COALESCE in the UPDATE SET
// clause) — a subset of starboard.test.js's DB assertions, real Postgres
// connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'starboard against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      getStarboardEntry,
      getStarboardEntryByPost,
      upsertStarboardEntry,
      setStarboardPost,
      setStarboardCount,
      deleteStarboardEntry,
      deleteBoardEntries,
    } = await import('../src/db/starboard.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G = `pgtest-star-${stamp}`;
    const B1 = 'b1';
    const B2 = 'b2';
    const M1 = '700000000000000101';
    const M2 = '700000000000000102';

    await t.test('upsert + get round-trip; setStarboardCount updates in place', async () => {
      assert.equal(await getStarboardEntry(G, B1, M1), null);

      await upsertStarboardEntry({
        guildId: G,
        boardId: B1,
        sourceMsgId: M1,
        sourceChanId: 'c1',
        starCount: 1,
      });
      await setStarboardPost(G, B1, M1, 'post-1', 12345);

      await setStarboardCount(G, B1, M1, 5);
      const row = await getStarboardEntry(G, B1, M1);
      assert.equal(row.star_count, 5);
      assert.equal(row.post_msg_id, 'post-1'); // untouched by setStarboardCount
      assert.equal(Number(row.posted_at), 12345);

      assert.deepEqual(await getStarboardEntryByPost('post-1'), row);
    });

    await t.test('deleteStarboardEntry / deleteBoardEntries scope correctly', async () => {
      await upsertStarboardEntry({
        guildId: G,
        boardId: B1,
        sourceMsgId: M2,
        sourceChanId: 'c1',
        starCount: 1,
      });
      await upsertStarboardEntry({
        guildId: G,
        boardId: B2,
        sourceMsgId: M1,
        sourceChanId: 'c1',
        starCount: 1,
      });

      await deleteStarboardEntry(G, B1, M1);
      assert.equal(await getStarboardEntry(G, B1, M1), null);
      assert.ok(await getStarboardEntry(G, B1, M2));

      await deleteBoardEntries(G, B1);
      assert.equal(await getStarboardEntry(G, B1, M2), null);
      assert.ok(await getStarboardEntry(G, B2, M1)); // other board untouched
    });
  }
);
