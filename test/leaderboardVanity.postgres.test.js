// Proves the driver shim's Postgres branch for leaderboard_vanity
// (single-column TEXT primary key + a UNIQUE slug) — same assertions as
// leaderboardVanity.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'leaderboardVanity against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { setVanitySlug, getVanitySlug, guildForVanity, clearVanitySlug } =
      await import('../src/db/leaderboardVanity.js');

    t.after(async () => {
      await closePostgres();
    });

    // `slug` is UNIQUE across every guild, not scoped like guild ids are — so
    // unlike the other *.postgres.test.js files, a hardcoded literal here
    // would collide with a leftover row from a previous run against a
    // persistent (non-CI-ephemeral) Postgres instance. Both the guild ids
    // and the slug text itself need to be unique per run.
    const stamp = Date.now();
    const A = `pgtest-vanity-a-${stamp}`;
    const B = `pgtest-vanity-b-${stamp}`;
    const slug = `priv-stuff-${stamp}`;
    const slug2 = `priv-stuff-${stamp}-2`;

    await t.test('claim, read back, reject a clash, allow re-set on same guild', async () => {
      assert.deepEqual(await setVanitySlug(A, slug), { ok: true, slug });
      assert.equal(await getVanitySlug(A), slug);
      assert.equal(await guildForVanity(slug), A);
      assert.equal(await guildForVanity(slug.toUpperCase()), A); // case-insensitive lookup

      assert.deepEqual(await setVanitySlug(B, slug), { ok: false, error: 'taken' });
      assert.deepEqual(await setVanitySlug(A, slug2), { ok: true, slug: slug2 });
      assert.equal(await getVanitySlug(A), slug2);
      assert.equal(await guildForVanity(slug), null); // old slug freed
      assert.deepEqual(await setVanitySlug(B, slug), { ok: true, slug });
    });

    await t.test('rejects an unfixable slug; clearVanitySlug frees it', async () => {
      assert.deepEqual(await setVanitySlug(A, '!!'), { ok: false, error: 'invalid' });
      await clearVanitySlug(A);
      assert.equal(await getVanitySlug(A), null);
    });
  }
);
