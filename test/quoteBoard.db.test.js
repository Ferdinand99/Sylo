// Quote board storage on SQLite: rows, per-server numbers that are never reused, random / search /
// public lists, the 10 000 row ceiling, and the per-member and per-server erasure that covers it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGuildQuotes,
  deleteQuote,
  getQuoteByMessage,
  getQuoteByNumber,
  insertQuote,
  publicQuoteCount,
  quoteCount,
  quoteCountOf,
  quotesByAuthor,
  randomQuote,
  recentPublicQuotes,
  recentQuotes,
  searchQuotes,
  takeQuoteNumber,
} from '../src/db/quotes.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import { saveQuote } from '../src/modules/quoteBoard.js';
import { runtime } from '../src/runtime.js';

const G = '900000000000000701';
const H = '900000000000000702';
let n = 0;
const add = (over = {}) => {
  n += 1;
  return insertQuote({
    guildId: G,
    channelId: '100000000000000101',
    messageId: `m${n}`,
    authorId: 'author',
    authorName: 'Author',
    body: `quote ${n}`,
    messageAt: 1_000 + n,
    savedBy: 'saver',
    ...over,
  });
};

test('both tables are covered by the guild purge list', () => {
  assert.ok(GUILD_TABLES.includes('guild_quotes'));
  assert.ok(GUILD_TABLES.includes('guild_quote_counters'));
});

test('a row round-trips with numbers; the first quote of a server is #1', async () => {
  const { number } = await add({
    messageId: 'first',
    authorName: 'Alice',
    body: 'hello',
    attachments: 2,
    messageAt: 1_700_000_000_000,
    savedAt: 1_700_000_001_000,
    publicSource: true,
  });
  assert.equal(number, 1);
  const row = await getQuoteByNumber(G, 1);
  assert.deepEqual(
    { ...row, id: typeof row.id },
    {
      id: 'number',
      guild_id: G,
      number: 1,
      channel_id: '100000000000000101',
      message_id: 'first',
      author_id: 'author',
      author_name: 'Alice',
      body: 'hello',
      attachments: 2,
      message_at: 1_700_000_000_000,
      saved_by: 'saver',
      saved_at: 1_700_000_001_000,
      public_source: 1,
    }
  );
  assert.deepEqual(await getQuoteByMessage(G, 'first'), row);
  assert.equal(await getQuoteByNumber(G, 2), null);
  assert.equal(await getQuoteByNumber(H, 1), null);
  assert.equal(await getQuoteByMessage(H, 'first'), null);
});

test('numbers count up per server and are never reused, not even after deleting the newest', async () => {
  const a = await add();
  const b = await add();
  assert.deepEqual([a.number, b.number], [2, 3]);
  await deleteQuote(b.id);
  await deleteQuote(a.id);
  assert.equal((await add()).number, 4);
  assert.equal((await add({ guildId: H })).number, 1, 'another server has its own count');
  assert.equal(await takeQuoteNumber(G), 5, 'the counter itself only goes up');
});

test('the same message cannot be stored twice in a server, but can in another', async () => {
  await add({ messageId: 'dup' });
  await assert.rejects(add({ messageId: 'dup' }), /UNIQUE|unique/);
  await add({ messageId: 'dup', guildId: H });
});

test("counts, a member's quotes and the newest list", async () => {
  await clearGuildQuotes(H);
  await insertQuote({ guildId: H, channelId: 'c', messageId: 'h1', authorId: 'x', body: 'x1', messageAt: 1 });
  await insertQuote({ guildId: H, channelId: 'c', messageId: 'h2', authorId: 'y', body: 'y1', messageAt: 2 });
  await insertQuote({ guildId: H, channelId: 'c', messageId: 'h3', authorId: 'x', body: 'x2', messageAt: 3 });
  assert.equal(await quoteCount(H), 3);
  assert.equal(await quoteCountOf(H, 'x'), 2);
  assert.deepEqual(
    (await quotesByAuthor(H, 'x')).map((q) => q.body),
    ['x2', 'x1']
  );
  assert.equal((await quotesByAuthor(H, 'x', 1)).length, 1);
  assert.deepEqual(
    (await recentQuotes(H, { limit: 2 })).map((q) => q.body),
    ['x2', 'y1']
  );
  assert.deepEqual(
    (await recentQuotes(H, { limit: 2, offset: 2 })).map((q) => q.body),
    ['x1']
  );
});

test('random picks by position: 0 is the oldest, just under 1 the newest, per member too', async () => {
  const body = async (opts) => (await randomQuote(H, opts)).body;
  assert.equal(await body({ pick: 0 }), 'x1');
  assert.equal(await body({ pick: 0.5 }), 'y1');
  assert.equal(await body({ pick: 0.9999 }), 'x2');
  assert.equal(await body({ pick: 1 }), 'x2', 'a pick of exactly 1 stays inside the list');
  assert.equal(await body({ pick: 0, authorId: 'x' }), 'x1');
  assert.equal(await body({ pick: 0.9, authorId: 'x' }), 'x2');
  assert.equal(await randomQuote(H, { authorId: 'nobody' }), null);
  assert.equal(await randomQuote('900000000000000799'), null);
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add((await randomQuote(H)).body);
  assert.equal(seen.size, 3, 'with the real random source every quote turns up');
});

test('search looks in the text and the author name, case-insensitively, newest first, with a limit', async () => {
  const S = '900000000000000703';
  const put = (messageId, body, authorName = 'Someone') =>
    insertQuote({ guildId: S, channelId: 'c', messageId, authorId: 'a', authorName, body, messageAt: 1 });
  await put('1', 'The Quick brown fox');
  await put('2', 'lazy dog');
  await put('3', 'a quick one', 'Quentin');
  await put('4', 'nothing', 'QUICKSAND');
  await put('5', '100% sure');
  await put('6', 'under_score and ! bang');
  const bodies = async (q, limit) => (await searchQuotes(S, q, limit)).map((r) => r.body);
  assert.deepEqual(await bodies('quick'), ['nothing', 'a quick one', 'The Quick brown fox']);
  assert.deepEqual(await bodies('QUICK', 2), ['nothing', 'a quick one']);
  assert.deepEqual(await bodies('100%'), ['100% sure']);
  assert.deepEqual(await bodies('%'), ['100% sure'], 'a percent sign is not a wildcard');
  assert.deepEqual(await bodies('_'), ['under_score and ! bang'], 'an underscore is not a wildcard');
  assert.deepEqual(await bodies('! b'), ['under_score and ! bang']);
  assert.deepEqual(await bodies('zzz'), []);
  assert.deepEqual(await bodies(`' OR 1=1 --`), [], 'the query is a bound value');
  assert.equal(
    (await searchQuotes('900000000000000798', 'quick')).length,
    0,
    'other servers are not searched'
  );
});

test('the public list holds only quotes from public sources, newest first, and counts them', async () => {
  const P = '900000000000000704';
  const put = (messageId, publicSource) =>
    insertQuote({
      guildId: P,
      channelId: 'c',
      messageId,
      authorId: 'a',
      body: messageId,
      messageAt: 1,
      publicSource,
    });
  await put('p1', true);
  await put('hidden', false);
  await put('p2', true);
  assert.equal(await publicQuoteCount(P), 2);
  assert.deepEqual(
    (await recentPublicQuotes(P)).map((r) => r.body),
    ['p2', 'p1']
  );
  assert.deepEqual(
    (await recentPublicQuotes(P, { limit: 1, offset: 1 })).map((r) => r.body),
    ['p1']
  );
  assert.equal((await recentQuotes(P)).length, 3);
});

test('saving stops at the ceiling of 10 000 quotes per server; a duplicate still answers', async () => {
  assert.equal(CEILINGS.quotes, 10_000);
  const C = '900000000000000705';
  for (let i = 0; i < CEILINGS.quotes; i += 1) {
    await insertQuote({
      guildId: C,
      channelId: 'c',
      messageId: `c${i}`,
      authorId: 'a',
      body: 'x',
      messageAt: i,
    });
  }
  runtime.clients.discord = { isReady: () => true, guilds: { cache: new Map() } };
  runtime.clients.fluxer = null;
  const guild = { id: C, client: runtime.clients.discord, roles: {}, channels: { cache: new Map() } };
  const message = (id) => ({
    id,
    channelId: 'c',
    content: 'one too many',
    author: { id: 'a', username: 'a' },
    attachments: { size: 0 },
    createdTimestamp: 5,
  });
  const full = await saveQuote({ guild, message: message('new'), savedBy: 'u' });
  assert.equal(full.ok, false);
  assert.match(full.error, /maximum of 10000 quotes/);
  assert.equal(await quoteCount(C), CEILINGS.quotes);

  const same = await saveQuote({ guild, message: message('c7'), savedBy: 'u' });
  assert.equal(same.ok, true);
  assert.equal(same.existing, true, 'a quote that exists is returned, not refused');

  // removing one makes room again
  await deleteQuote((await getQuoteByNumber(C, 1)).id);
  const room = await saveQuote({ guild, message: message('new'), savedBy: 'u' });
  assert.equal(room.ok, true);
  assert.equal(room.quote.number, CEILINGS.quotes + 1, 'and the number is a new one');
});

// --- /forget, /mydata and leaving a server -----------------------------------------------------------------------------

test('forgetUser deletes quotes the person wrote and clears their name from quotes they saved', async () => {
  const F = '900000000000000706';
  const put = (messageId, authorId, savedBy, body) =>
    insertQuote({
      guildId: F,
      channelId: 'c',
      messageId,
      authorId,
      authorName: authorId,
      body,
      messageAt: 1,
      savedBy,
    });
  await put('1', 'victim', 'friend', 'victim wrote, friend saved');
  await put('2', 'victim', 'victim', 'victim wrote and saved');
  await put('3', 'friend', 'victim', 'friend wrote, victim saved');
  await put('4', 'friend', 'friend', 'unrelated');
  await put('5', 'victim', null, 'victim wrote, saver already forgotten');
  // the same person in another server
  await insertQuote({
    guildId: H,
    channelId: 'c',
    messageId: 'other-g',
    authorId: 'victim',
    body: 'elsewhere',
    messageAt: 1,
    savedBy: 'victim',
  });

  const seen = await describeUserData(F, 'victim');
  const count = (key) => seen.items.find((i) => i.key === key).count;
  assert.deepEqual([count('quotes'), count('quotesSaved')], [3, 2]);
  const exported = await exportUserData(F, 'victim');
  assert.deepEqual(
    exported.data.quotes.map((q) => q.number),
    [1, 2, 5]
  );
  assert.equal(exported.data.quotes[0].body, 'victim wrote, friend saved');
  assert.deepEqual(
    exported.data.quotesSaved.map((q) => q.number),
    [2, 3]
  );

  const r = await forgetUser(F, 'victim');
  assert.deepEqual(
    [r.quotes, r.quotesSaved],
    [3, 1],
    'the quote they wrote and saved counts once, as deleted'
  );
  assert.deepEqual(
    (await recentQuotes(F)).map((q) => [q.number, q.saved_by]),
    [
      [4, 'friend'],
      [3, null],
    ]
  );
  assert.equal(
    (await getQuoteByNumber(F, 3)).body,
    'friend wrote, victim saved',
    'their words stay on the board'
  );
  assert.ok((await quoteCount(H)) > 0, 'other servers are untouched');
  assert.equal((await getQuoteByMessage(H, 'other-g')).saved_by, 'victim');

  // the deleted numbers stay used
  assert.equal(
    (await insertQuote({ guildId: F, channelId: 'c', messageId: '6', authorId: 'z', messageAt: 1 })).number,
    6
  );

  const after = await describeUserData(F, 'victim');
  const left = (key) => after.items.find((i) => i.key === key).count;
  assert.deepEqual([left('quotes'), left('quotesSaved')], [0, 0]);
});

test('purgeGuild removes the quotes and the counter of a server, and only that server', async () => {
  const Q = '900000000000000707';
  await insertQuote({ guildId: Q, channelId: 'c', messageId: 'q1', authorId: 'a', messageAt: 1 });
  await insertQuote({ guildId: Q, channelId: 'c', messageId: 'q2', authorId: 'a', messageAt: 1 });
  const others = await quoteCount(H);
  assert.ok(others > 0);
  await purgeGuild(Q);
  assert.equal(await quoteCount(Q), 0);
  assert.equal(await quoteCount(H), others);
  assert.equal(
    (await insertQuote({ guildId: Q, channelId: 'c', messageId: 'q3', authorId: 'a', messageAt: 1 })).number,
    1,
    'a server that left and came back starts at #1'
  );
});
