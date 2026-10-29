// Proves the driver shim's Postgres branch for suggestions + votes: a SERIAL id read back with
// RETURNING, the per-server number taken from a MAX() subselect on the same table, COUNT and BIGINT
// values that come back as numbers, the vote upsert, the filtered lists, and the erasure statements.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'suggestions against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/suggestions.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-suggestions-${Date.now()}`;
    const H = `${G}-other`;
    const make = (over = {}) =>
      db.createSuggestion({ guildId: G, channelId: '1', authorId: 'a1', body: 'Idea', ...over });

    await t.test('numbers are per server and sequential; the row round-trips with numbers', async () => {
      const a = await make({ title: 'T', anonymous: true, createdAt: 1_800_000_000_000 });
      const b = await make();
      const o = await make({ guildId: H });
      assert.ok(Number.isInteger(a.id) && a.id > 0);
      assert.deepEqual([a.number, b.number, o.number], [1, 2, 1]);
      await db.setSuggestionMessage(a.id, '9', '333');
      const row = await db.getSuggestion(a.id);
      assert.equal(row.number, 1);
      assert.equal(row.anonymous, true);
      assert.equal(row.message_id, '333');
      assert.equal(row.created_at, 1_800_000_000_000);
      assert.equal(typeof row.created_at, 'number');
      assert.equal(row.decided_at, null);
      assert.equal(typeof row.up, 'number');
      assert.equal(await db.getSuggestionInGuild(a.id, H), null);
      assert.equal((await db.getSuggestionByNumber(G, 2)).id, b.id);
    });

    await t.test('votes: the upsert changes the vote without a second row; tallies are numbers', async () => {
      const { id } = await make();
      await db.setSuggestionVote(id, 'u1', 1);
      await db.setSuggestionVote(id, 'u2', -1);
      await db.setSuggestionVote(id, 'u2', 1); // ON CONFLICT DO UPDATE
      assert.deepEqual(await db.voteTally(id), { up: 2, down: 0 });
      assert.equal(await db.getSuggestionVote(id, 'u2'), 1);
      await db.removeSuggestionVote(id, 'u1');
      assert.deepEqual(await db.voteTally(id), { up: 1, down: 0 });
      assert.equal(await db.getSuggestionVote(id, 'u1'), 0);
      assert.deepEqual(await db.voteTally(987654321), { up: 0, down: 0 });
    });

    await t.test('decisions, filtered lists, sort by votes and the per-member counts', async () => {
      await db.clearGuildSuggestions(G);
      const a = await make({ body: 'a', authorId: 'm1', createdAt: 1000 });
      const b = await make({ body: 'b', authorId: 'm1', createdAt: 2000 });
      const c = await make({ body: 'c', authorId: 'm2', createdAt: 3000 });
      await db.setSuggestionVote(a.id, 'u1', 1);
      await db.setSuggestionVote(a.id, 'u2', 1);
      await db.setSuggestionVote(b.id, 'u1', -1);
      await db.decideSuggestion(b.id, { status: 'denied', reason: 'no', decidedBy: 's1', decidedAt: 99 });
      await db.decideSuggestion(c.id, { status: 'considering' });
      const decided = await db.getSuggestion(b.id);
      assert.equal(decided.decided_at, 99);
      assert.equal(typeof decided.decided_at, 'number');
      const bodies = async (opts) => (await db.listSuggestions(G, opts)).map((r) => r.body);
      assert.deepEqual(await bodies(), ['c', 'b', 'a']);
      assert.deepEqual(await bodies({ sort: 'top' }), ['a', 'c', 'b']);
      assert.deepEqual(await bodies({ status: 'open' }), ['c', 'a']);
      assert.deepEqual(await bodies({ status: 'denied' }), ['b']);
      assert.equal((await db.listSuggestions(G, { sort: 'top' }))[0].up, 2);
      assert.equal(await db.suggestionCount(G), 3);
      assert.equal(await db.openSuggestionCount(G), 2);
      assert.equal(await db.openSuggestionCountOf(G, 'm1'), 1);
      assert.equal(await db.lastSuggestionAtOf(G, 'm1'), 2000);
      assert.equal(await db.lastSuggestionAtOf(G, 'nobody'), 0);
      await db.deleteSuggestion(a.id);
      assert.equal(await db.getSuggestion(a.id), null);
      assert.equal(await db.getSuggestionVote(a.id, 'u1'), 0);
    });

    await t.test('forgetUser, describeUserData and purgeGuild cover votes and authors', async () => {
      await db.clearGuildSuggestions(G);
      await db.clearGuildSuggestions(H);
      const mine = await make({ authorId: 'victim', body: 'my idea' });
      const theirs = await make({ authorId: 'other' });
      const elsewhere = await make({ guildId: H, authorId: 'victim' });
      await db.setSuggestionVote(mine.id, 'victim', 1);
      await db.setSuggestionVote(theirs.id, 'victim', -1);
      await db.setSuggestionVote(elsewhere.id, 'victim', 1);
      await db.decideSuggestion(theirs.id, { status: 'approved', decidedBy: 'victim' });

      const seen = await purge.describeUserData(G, 'victim');
      const n = (key) => seen.items.find((i) => i.key === key).count;
      assert.deepEqual([n('suggestionVotes'), n('suggestions'), n('suggestionDecisions')], [2, 1, 1]);
      const exported = await purge.exportUserData(G, 'victim');
      assert.equal(exported.data.suggestionVotes.length, 2);
      assert.equal(exported.data.suggestions[0].body, 'my idea');

      const r = await purge.forgetUser(G, 'victim');
      assert.deepEqual([r.suggestionVotes, r.suggestions, r.suggestionDecisions], [2, 1, 1]);
      assert.equal(await db.getSuggestionVote(mine.id, 'victim'), 0);
      assert.equal((await db.getSuggestion(mine.id)).author_id, null);
      assert.equal((await db.getSuggestion(mine.id)).body, 'my idea');
      assert.equal((await db.getSuggestion(theirs.id)).decided_by, null);
      assert.equal((await db.getSuggestion(elsewhere.id)).author_id, 'victim');
      assert.equal(await db.getSuggestionVote(elsewhere.id, 'victim'), 1);

      await purge.purgeGuild(G);
      assert.equal(await db.getSuggestion(mine.id), null);
      assert.equal(await db.getSuggestionVote(theirs.id, 'victim'), 0);
      assert.ok(await db.getSuggestion(elsewhere.id));
      await purge.purgeGuild(H);
      assert.equal(await db.getSuggestion(elsewhere.id), null);
    });
  }
);
