// Proves the driver shim's Postgres branch for the Quote board: the counter upsert and RETURNING id,
// BIGINT times that come back as numbers, the unique message index, the escaped LIKE search, the
// random-by-offset pick, and the erasure statements.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'the quote board against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/quotes.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-quotes-${Date.now()}`;
    const H = `${G}-other`;
    let n = 0;
    const add = (over = {}) => {
      n += 1;
      return db.insertQuote({
        guildId: G,
        channelId: 'c1',
        messageId: `m${n}`,
        authorId: 'author',
        authorName: 'Author',
        body: `quote ${n}`,
        messageAt: 1_700_000_000_000 + n,
        savedBy: 'saver',
        ...over,
      });
    };

    await t.test('numbers come from the counter and are never reused; times are numbers', async () => {
      const a = await add({ messageId: 'first', attachments: 2, publicSource: true });
      assert.equal(a.number, 1);
      assert.equal(typeof a.id, 'number');
      const b = await add();
      assert.equal(b.number, 2);
      await db.deleteQuote(b.id);
      assert.equal((await add()).number, 3);
      assert.equal((await add({ guildId: H })).number, 1);
      const row = await db.getQuoteByNumber(G, 1);
      assert.equal(row.number, 1);
      assert.equal(typeof row.message_at, 'number');
      assert.equal(typeof row.saved_at, 'number');
      assert.equal(row.message_at, 1_700_000_000_001);
      assert.equal(row.attachments, 2);
      assert.equal(row.public_source, 1);
      assert.equal(typeof (await db.quoteCount(G)), 'number');
      assert.equal(await db.quoteCount(G), 2);
    });

    await t.test('a message can be stored once per server', async () => {
      await assert.rejects(add({ messageId: 'first' }), /unique|duplicate/i);
      assert.equal((await db.getQuoteByMessage(G, 'first')).number, 1);
      await add({ guildId: H, messageId: 'first' });
    });

    await t.test('search is case-insensitive, escaped and limited; random picks by position', async () => {
      await db.clearGuildQuotes(H);
      const put = (messageId, body, authorName = 'Someone') =>
        db.insertQuote({
          guildId: H,
          channelId: 'c',
          messageId,
          authorId: 'a',
          authorName,
          body,
          messageAt: 1,
        });
      await put('s1', 'The Quick brown fox');
      await put('s2', '100% sure');
      await put('s3', 'under_score');
      await put('s4', 'zzz', 'QUICKSAND');
      const bodies = async (q, limit) => (await db.searchQuotes(H, q, limit)).map((r) => r.body);
      assert.deepEqual(await bodies('quick'), ['zzz', 'The Quick brown fox']);
      assert.deepEqual(await bodies('quick', 1), ['zzz']);
      assert.deepEqual(await bodies('%'), ['100% sure']);
      assert.deepEqual(await bodies('_'), ['under_score']);
      assert.deepEqual(await bodies(`' OR 1=1 --`), []);
      assert.equal((await db.randomQuote(H, { pick: 0 })).body, 'The Quick brown fox');
      assert.equal((await db.randomQuote(H, { pick: 0.99 })).body, 'zzz');
      assert.equal(await db.randomQuote(H, { pick: 0, authorId: 'nobody' }), null);
      assert.equal((await db.recentQuotes(H, { limit: 2, offset: 1 })).length, 2);
      assert.equal(await db.publicQuoteCount(H), 0);
      assert.equal((await db.recentPublicQuotes(H)).length, 0);
    });

    await t.test('forgetUser, describeUserData and purgeGuild cover the author and the saver', async () => {
      await db.clearGuildQuotes(G);
      await db.clearGuildQuotes(H);
      const put = (messageId, authorId, savedBy) =>
        db.insertQuote({
          guildId: G,
          channelId: 'c',
          messageId,
          authorId,
          body: messageId,
          messageAt: 1,
          savedBy,
        });
      await put('1', 'victim', 'friend');
      await put('2', 'victim', 'victim');
      await put('3', 'friend', 'victim');
      await put('4', 'friend', 'friend');
      await db.insertQuote({
        guildId: H,
        channelId: 'c',
        messageId: 'x',
        authorId: 'victim',
        body: 'other server',
        messageAt: 1,
        savedBy: 'victim',
      });

      const seen = await purge.describeUserData(G, 'victim');
      const count = (key) => seen.items.find((i) => i.key === key).count;
      assert.deepEqual([count('quotes'), count('quotesSaved')], [2, 2]);
      const exported = await purge.exportUserData(G, 'victim');
      assert.equal(exported.data.quotes.length, 2);

      const r = await purge.forgetUser(G, 'victim');
      assert.deepEqual([r.quotes, r.quotesSaved], [2, 1]);
      assert.deepEqual(
        (await db.recentQuotes(G)).map((q) => [q.number, q.saved_by]),
        [
          [4, 'friend'],
          [3, null],
        ]
      );
      assert.equal((await db.getQuoteByMessage(H, 'x')).saved_by, 'victim', 'another server is untouched');
      assert.equal((await add()).number, 5, 'the counter kept counting');

      await purge.purgeGuild(G);
      assert.equal(await db.quoteCount(G), 0);
      assert.equal(await db.quoteCount(H), 1);
      assert.equal((await add()).number, 1, 'a purged server starts again at #1');
      await purge.purgeGuild(G);
      await purge.purgeGuild(H);
      assert.equal(await db.quoteCount(H), 0);
    });
  }
);
