// Suggestions storage on SQLite, and the per-member / per-server erasure that covers it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGuildSuggestions,
  createSuggestion,
  decideSuggestion,
  deleteSuggestion,
  getSuggestion,
  getSuggestionByNumber,
  getSuggestionInGuild,
  getSuggestionVote,
  lastSuggestionAtOf,
  listSuggestions,
  openSuggestionCount,
  openSuggestionCountOf,
  removeSuggestionVote,
  setSuggestionMessage,
  setSuggestionVote,
  suggestionCount,
  voteTally,
} from '../src/db/suggestions.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';

const G = '900000000000000421';
const H = '900000000000000422';
const make = (over = {}) =>
  createSuggestion({ guildId: G, channelId: '100000000000000001', authorId: 'a1', body: 'Idea', ...over });

test('numbers count up per server, starting at 1, and a row round-trips', async () => {
  const a = await make({ title: 'T', anonymous: true });
  const b = await make();
  const other = await make({ guildId: H });
  assert.deepEqual([a.number, b.number, other.number], [1, 2, 1], 'each server has its own sequence');
  assert.ok(a.id !== other.id);

  await setSuggestionMessage(a.id, '100000000000000009', '333');
  const row = await getSuggestion(a.id);
  assert.equal(row.number, 1);
  assert.equal(row.title, 'T');
  assert.equal(row.body, 'Idea');
  assert.equal(row.anonymous, true);
  assert.equal(row.channel_id, '100000000000000009');
  assert.equal(row.message_id, '333');
  assert.equal(row.status, 'open');
  assert.equal(row.reason, '');
  assert.equal(row.decided_by, null);
  assert.equal(row.decided_at, null);
  assert.equal(typeof row.created_at, 'number');
  assert.equal(row.up, 0);
  assert.equal(row.down, 0);
  assert.equal((await getSuggestionByNumber(G, 2)).id, b.id);
  assert.equal(await getSuggestionByNumber(G, 99), null);
  assert.equal((await getSuggestionInGuild(a.id, G)).id, a.id);
  assert.equal(await getSuggestionInGuild(a.id, H), null, 'another server does not see it');
  assert.equal(await getSuggestion(987654), null);
  assert.equal((await make({ anonymous: false })).number, 3);
});

test('a number is never reused: deleting the newest suggestion does not hand its number to the next', async () => {
  const g = '900000000000000439';
  const a = await make({ guildId: g });
  const b = await make({ guildId: g });
  assert.deepEqual([a.number, b.number], [1, 2]);
  await deleteSuggestion(b.id);
  assert.equal((await make({ guildId: g })).number, 3);
  await deleteSuggestion(a.id);
  assert.equal((await make({ guildId: g })).number, 4);
  // leaving the server erases the counter with the rest of its data
  await purgeGuild(g);
  assert.equal((await make({ guildId: g })).number, 1);
  assert.ok(GUILD_TABLES.includes('guild_suggestion_counters'));
});

test('votes: one row per member, changing it keeps one row, removing deletes it', async () => {
  const { id } = await make({ guildId: '900000000000000430' });
  await setSuggestionVote(id, 'u1', 1);
  await setSuggestionVote(id, 'u2', -1);
  await setSuggestionVote(id, 'u3', 1);
  assert.deepEqual(await voteTally(id), { up: 2, down: 1 });
  assert.equal(await getSuggestionVote(id, 'u2'), -1);
  assert.equal(await getSuggestionVote(id, 'nobody'), 0);

  await setSuggestionVote(id, 'u2', 1); // change
  assert.deepEqual(await voteTally(id), { up: 3, down: 0 });
  await setSuggestionVote(id, 'u2', 1); // again: still one row
  assert.deepEqual(await voteTally(id), { up: 3, down: 0 });
  await removeSuggestionVote(id, 'u1');
  assert.deepEqual(await voteTally(id), { up: 2, down: 0 });
  assert.equal(await getSuggestionVote(id, 'u1'), 0);
  const row = await getSuggestion(id);
  assert.deepEqual([row.up, row.down], [2, 0], 'the row carries the counts');
  assert.deepEqual(await voteTally(987654), { up: 0, down: 0 });
});

test('a decision is stored with who, when and why', async () => {
  const { id } = await make({ guildId: '900000000000000431' });
  await decideSuggestion(id, {
    status: 'approved',
    reason: 'Good one',
    decidedBy: 'staff1',
    decidedAt: 1234,
  });
  const row = await getSuggestion(id);
  assert.equal(row.status, 'approved');
  assert.equal(row.reason, 'Good one');
  assert.equal(row.decided_by, 'staff1');
  assert.equal(row.decided_at, 1234);
  await decideSuggestion(id, { status: 'implemented' });
  const again = await getSuggestion(id);
  assert.equal(again.status, 'implemented');
  assert.equal(again.reason, '', 'a new decision replaces the reason');
  assert.equal(again.decided_by, null);
  assert.equal(typeof again.decided_at, 'number');
});

test('the list filters by status and sorts by newest or by net votes', async () => {
  const g = '900000000000000432';
  const a = await make({ guildId: g, body: 'a' });
  const b = await make({ guildId: g, body: 'b' });
  const c = await make({ guildId: g, body: 'c' });
  const d = await make({ guildId: g, body: 'd' });
  await setSuggestionVote(a.id, 'u1', 1);
  await setSuggestionVote(a.id, 'u2', 1);
  await setSuggestionVote(b.id, 'u1', -1);
  await setSuggestionVote(c.id, 'u1', 1);
  await decideSuggestion(b.id, { status: 'denied' });
  await decideSuggestion(c.id, { status: 'considering' });
  await decideSuggestion(d.id, { status: 'approved' });
  const bodies = async (opts) => (await listSuggestions(g, opts)).map((r) => r.body);

  assert.deepEqual(await bodies(), ['d', 'c', 'b', 'a'], 'newest first by default');
  assert.deepEqual(
    await bodies({ sort: 'top' }),
    ['a', 'c', 'd', 'b'],
    'best net votes first, newest breaks ties'
  );
  assert.deepEqual(await bodies({ status: 'open' }), ['c', 'a'], 'open covers considering too');
  assert.deepEqual(await bodies({ status: 'denied' }), ['b']);
  assert.deepEqual(await bodies({ status: 'approved' }), ['d']);
  assert.deepEqual(await bodies({ status: 'considering' }), ['c']);
  assert.deepEqual(await bodies({ status: 'implemented' }), []);
  assert.deepEqual(await bodies({ status: 'bogus' }), ['d', 'c', 'b', 'a'], 'an unknown filter is "all"');
  assert.deepEqual(await bodies({ limit: 2 }), ['d', 'c']);
  const top = (await listSuggestions(g, { sort: 'top' }))[0];
  assert.deepEqual([top.up, top.down], [2, 0]);
  assert.equal(await openSuggestionCount(g), 2);
  assert.equal(await suggestionCount(g), 4);
});

test('per-member counts: open ones, and when the member last made one', async () => {
  const g = '900000000000000433';
  const a = await make({ guildId: g, authorId: 'm1', createdAt: 1000 });
  await make({ guildId: g, authorId: 'm1', createdAt: 5000 });
  await make({ guildId: g, authorId: 'm1', createdAt: 3000 });
  await make({ guildId: g, authorId: 'm2', createdAt: 9000 });
  assert.equal(await openSuggestionCountOf(g, 'm1'), 3);
  assert.equal(await lastSuggestionAtOf(g, 'm1'), 5000);
  assert.equal(await lastSuggestionAtOf(g, 'nobody'), 0);
  await decideSuggestion(a.id, { status: 'denied' });
  assert.equal(await openSuggestionCountOf(g, 'm1'), 2, 'a decided one no longer counts');
  const considered = await make({ guildId: g, authorId: 'm3' });
  await decideSuggestion(considered.id, { status: 'considering' });
  assert.equal(await openSuggestionCountOf(g, 'm3'), 1, 'considering is still open');
});

test('deleting a suggestion removes its votes too', async () => {
  const { id } = await make({ guildId: '900000000000000434' });
  await setSuggestionVote(id, 'u1', 1);
  await deleteSuggestion(id);
  assert.equal(await getSuggestion(id), null);
  assert.equal(await getSuggestionVote(id, 'u1'), 0);
});

test('/forget removes the votes, drops the author id but keeps the text, and drops the staff id', async () => {
  const g = '900000000000000435';
  const other = '900000000000000436';
  const mine = await make({ guildId: g, authorId: 'victim', body: 'my idea' });
  const theirs = await make({ guildId: g, authorId: 'bystander', body: 'their idea' });
  const elsewhere = await make({ guildId: other, authorId: 'victim', body: 'other server' });
  await setSuggestionVote(mine.id, 'victim', 1);
  await setSuggestionVote(theirs.id, 'victim', -1);
  await setSuggestionVote(theirs.id, 'bystander', 1);
  await setSuggestionVote(elsewhere.id, 'victim', 1);
  await decideSuggestion(theirs.id, { status: 'approved', reason: 'ok', decidedBy: 'victim' });

  const seen = await describeUserData(g, 'victim');
  const count = (key) => seen.items.find((i) => i.key === key);
  assert.equal(count('suggestionVotes').count, 2);
  assert.equal(count('suggestions').count, 1);
  assert.equal(count('suggestionDecisions').count, 1);
  assert.equal(count('suggestionVotes').kept, false);
  assert.equal(count('suggestions').kept, false);
  assert.ok(seen.erasable >= 4);

  const exported = await exportUserData(g, 'victim');
  assert.equal(exported.data.suggestionVotes.length, 2);
  assert.equal(exported.data.suggestions[0].body, 'my idea');
  assert.equal(exported.data.suggestionDecisions[0].reason, 'ok');
  assert.equal(exported.data.suggestionDecisions[0].author_id, undefined, 'no one else is named');

  const result = await forgetUser(g, 'victim');
  assert.equal(result.suggestionVotes, 2);
  assert.equal(result.suggestions, 1);
  assert.equal(result.suggestionDecisions, 1);
  assert.equal(await getSuggestionVote(mine.id, 'victim'), 0);
  assert.equal(await getSuggestionVote(theirs.id, 'victim'), 0);
  assert.equal(await getSuggestionVote(theirs.id, 'bystander'), 1, 'other members keep their votes');

  const kept = await getSuggestion(mine.id);
  assert.equal(kept.body, 'my idea', 'the text stays so the server keeps its board');
  assert.equal(kept.author_id, null);
  assert.equal(kept.number, mine.number);
  const decided = await getSuggestion(theirs.id);
  assert.equal(decided.decided_by, null);
  assert.equal(decided.status, 'approved');
  assert.equal(decided.author_id, 'bystander');
  assert.equal((await getSuggestion(elsewhere.id)).author_id, 'victim', 'another server is untouched');
  assert.equal(await getSuggestionVote(elsewhere.id, 'victim'), 1);
  assert.equal((await describeUserData(g, 'victim')).items.find((i) => i.key === 'suggestions').count, 0);
  assert.equal((await describeUserData(g, 'victim')).items.find((i) => i.key === 'suggestionVotes').count, 0);
});

test('purgeGuild and clearGuildSuggestions remove suggestions and votes; the table is on the guild list', async () => {
  assert.ok(GUILD_TABLES.includes('guild_suggestions'));
  const a = await make({ guildId: '900000000000000437' });
  await setSuggestionVote(a.id, 'u1', 1);
  const keep = await make({ guildId: '900000000000000438' });
  await setSuggestionVote(keep.id, 'u1', 1);
  await purgeGuild('900000000000000437');
  assert.equal(await getSuggestion(a.id), null);
  assert.equal(await getSuggestionVote(a.id, 'u1'), 0);
  assert.ok(await getSuggestion(keep.id), 'another server is untouched');

  await clearGuildSuggestions('900000000000000438');
  assert.equal(await getSuggestion(keep.id), null);
  assert.equal(await getSuggestionVote(keep.id, 'u1'), 0);
});
