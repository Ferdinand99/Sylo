// Proves the driver shim's Postgres branch for posted_keys — specifically the
// two statements that needed a real dialect rewrite (not just placeholder
// translation): `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`, and
// `key GLOB ?` -> `key LIKE ?`. Real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'postedKeys against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { seen, seenValue, anySeenMatching, markSeen, forget, clearScope, clearGuildPostedKeys } =
      await import('../src/db/postedKeys.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-keys-${Date.now()}`;

    await t.test('markSeen / seen round-trip; default insert does not overwrite, upsert does', async () => {
      assert.equal(await seen(G, 'demo', 'a'), false);
      await markSeen(G, 'demo', 'a');
      assert.equal(await seen(G, 'demo', 'a'), true);

      await markSeen(G, 'val', 'k', 'first');
      await markSeen(G, 'val', 'k', 'second'); // ON CONFLICT DO NOTHING -> ignored
      assert.equal(await seenValue(G, 'val', 'k'), 'first');
      await markSeen(G, 'val', 'k', 'third', { upsert: true });
      assert.equal(await seenValue(G, 'val', 'k'), 'third');
    });

    await t.test('anySeenMatching (GLOB -> LIKE rewrite) matches on a key prefix', async () => {
      await markSeen(G, 'yt-video', 'UCabc:vid1');
      await markSeen(G, 'yt-video', 'UCabc:vid2');
      assert.equal(await anySeenMatching(G, 'yt-video', 'UCabc:*'), true);
      assert.equal(await anySeenMatching(G, 'yt-video', 'UCxyz:*'), false);
    });

    await t.test('forget / clearScope / clearGuildPostedKeys scope correctly', async () => {
      await markSeen(G, 's1', 'a');
      await markSeen(G, 's1', 'b');
      await markSeen(G, 's2', 'a');
      await forget(G, 's1', 'a');
      assert.equal(await seen(G, 's1', 'a'), false);
      assert.equal(await seen(G, 's1', 'b'), true);

      await clearScope(G, 's1');
      assert.equal(await seen(G, 's1', 'b'), false);
      assert.equal(await seen(G, 's2', 'a'), true);

      await clearGuildPostedKeys(G);
      assert.equal(await seen(G, 's2', 'a'), false);
    });
  }
);
