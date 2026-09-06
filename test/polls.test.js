import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LETTERS,
  MAX_OPTIONS,
  parseChoices,
  normalisePollsConfig,
  buildPollPayload,
  buildResultsPayload,
} from '../src/modules/polls.js';
import {
  createPoll,
  getPoll,
  pollsInChannel,
  latestPollInChannel,
  duePolls,
  guildPollCount,
  deletePoll,
  clearGuildPolls,
} from '../src/db/polls.js';

const G = '900000000000000040';
const CH = '700000000000000401';

test('LETTERS: 20 distinct regional-indicator emoji', () => {
  assert.equal(LETTERS.length, 20);
  assert.equal(new Set(LETTERS).size, 20);
  assert.equal(LETTERS[0], '🇦');
  assert.equal(MAX_OPTIONS, 20);
});

test('parseChoices: splits on | first, then newlines, then commas; trims + dedupes + caps', () => {
  assert.deepEqual(parseChoices('Pizza | Tacos | Sushi'), ['Pizza', 'Tacos', 'Sushi']);
  assert.deepEqual(parseChoices('one\n two \nthree'), ['one', 'two', 'three']);
  assert.deepEqual(parseChoices('a, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(parseChoices('Yes | yes | YES | no'), ['Yes', 'no']); // case-insensitive dedupe
  assert.equal(parseChoices(Array.from({ length: 40 }, (_, i) => `opt${i}`).join('|')).length, MAX_OPTIONS);
  assert.deepEqual(parseChoices('  '), []);
});

test('normalisePollsConfig: defaults, mode + role validation, message templates', () => {
  const d = normalisePollsConfig();
  assert.equal(d.voteRoleMode, 'allow');
  assert.deepEqual(d.voteRoles, []);
  assert.deepEqual(d.pollMessage, { content: '', title: '', color: '#5b7cfa', footer: '', image: '' });
  assert.deepEqual(d.resultsMessage, { content: '', title: '', color: '#5b7cfa', footer: '', image: '' });

  const c = normalisePollsConfig({
    voteRoleMode: 'deny',
    voteRoles: ['123456789012345678', 'bad', '123456789012345678'],
    pollMessage: { title: '  Vote  now ', color: 'ff0000', image: 'not-a-url' },
    resultsMessage: { content: 'done', image: 'https://x/y.png' },
  });
  assert.equal(c.voteRoleMode, 'deny');
  assert.deepEqual(c.voteRoles, ['123456789012345678']);
  assert.equal(c.pollMessage.title, 'Vote now');
  assert.equal(c.pollMessage.color, '#ff0000');
  assert.equal(c.pollMessage.image, ''); // rejected
  assert.equal(c.resultsMessage.image, 'https://x/y.png');
});

test('legacy top-level color seeds both message templates', () => {
  const c = normalisePollsConfig({ color: '00ff00' });
  assert.equal(c.pollMessage.color, '#00ff00');
  assert.equal(c.resultsMessage.color, '#00ff00');
});

test('buildPollPayload: default layout lists options + meta', () => {
  const poll = {
    question: 'Best language?',
    options: ['JS', 'Rust', 'Go'],
    multiple: false,
    max_votes: 10,
    ends_at: null,
    created_at: 0,
  };
  const p = buildPollPayload(poll, {});
  const e = p.embeds[0].data;
  assert.equal(p.content, undefined); // no content override
  assert.match(e.title, /Best language\?/);
  assert.match(e.description, /🇦 {2}JS/);
  assert.match(e.description, /🇨 {2}Go/);
  assert.match(e.footer.text, /No time limit/);
  assert.match(e.footer.text, /One vote each · closes at 10 votes/);
});

test('buildPollPayload: templates substitute placeholders', () => {
  const poll = {
    question: 'Pineapple on pizza?',
    options: ['Yes', 'No'],
    multiple: true,
    max_votes: 0,
    ends_at: null,
  };
  const p = buildPollPayload(poll, {
    pollMessage: { content: 'Vote: {question}', title: 'POLL — {question}', footer: 'Mode: {mode}' },
  });
  assert.equal(p.content, 'Vote: Pineapple on pizza?');
  assert.equal(p.embeds[0].data.title, 'POLL — Pineapple on pizza?');
  assert.equal(p.embeds[0].data.footer.text, 'Mode: Multiple choices allowed');
});

test('buildResultsPayload: percentages, winner, and the no-votes case', () => {
  const poll = { question: 'Q', options: ['A', 'B', 'C'], multiple: false, max_votes: 0 };
  const e = buildResultsPayload(poll, [{ count: 5 }, { count: 3 }, { count: 2 }], {}).embeds[0].data;
  assert.match(e.description, /50\.0% · 5 votes/);
  assert.match(e.description, /30\.0% · 3 votes/);
  assert.match(e.footer.text, /Winner: A · 10 total votes/);

  const none = buildResultsPayload(poll, [{ count: 0 }, { count: 0 }, { count: 0 }], {}).embeds[0].data;
  assert.match(none.footer.text, /No votes were cast/);
});

test('buildResultsPayload: template placeholders', () => {
  const poll = { question: 'Q', options: ['A', 'B'], multiple: false, max_votes: 0 };
  const p = buildResultsPayload(poll, [{ count: 4 }, { count: 1 }], {
    resultsMessage: { content: '{winner} wins with {total} votes', title: 'Done: {question}' },
  });
  assert.equal(p.content, 'A wins with 5 votes');
  assert.equal(p.embeds[0].data.title, 'Done: Q');
});

test('polls table: create + get round-trips, hydrates options as an array', async () => {
  await clearGuildPolls(G);
  await createPoll({
    messageId: 'm1',
    guildId: G,
    channelId: CH,
    question: 'Best?',
    options: ['A', 'B'],
    multiple: false,
    maxVotes: 0,
    endsAt: null,
    createdBy: 'u1',
    createdAt: 1000,
  });
  const p = await getPoll('m1');
  assert.equal(p.question, 'Best?');
  assert.deepEqual(p.options, ['A', 'B']);
  assert.equal(p.created_at, 1000);
  assert.equal(p.ends_at, null);

  assert.equal(await getPoll('nope'), null);
});

test('pollsInChannel/latestPollInChannel order by created_at desc; guildPollCount counts', async () => {
  await clearGuildPolls(G);
  await createPoll({
    messageId: 'm1',
    guildId: G,
    channelId: CH,
    question: 'Q1',
    options: ['A'],
    multiple: false,
    maxVotes: 0,
    createdBy: 'u1',
    createdAt: 1000,
  });
  await createPoll({
    messageId: 'm2',
    guildId: G,
    channelId: CH,
    question: 'Q2',
    options: ['A'],
    multiple: false,
    maxVotes: 0,
    createdBy: 'u1',
    createdAt: 2000,
  });

  const inCh = await pollsInChannel(G, CH);
  assert.deepEqual(
    inCh.map((p) => p.message_id),
    ['m2', 'm1']
  );
  const latest = await latestPollInChannel(G, CH);
  assert.equal(latest.message_id, 'm2');
  assert.equal(await guildPollCount(G), 2);
});

test('duePolls returns only ended polls; deletePoll/clearGuildPolls remove rows', async () => {
  await clearGuildPolls(G);
  const now = Date.now();
  await createPoll({
    messageId: 'm1',
    guildId: G,
    channelId: CH,
    question: 'Q',
    options: ['A'],
    multiple: false,
    maxVotes: 0,
    endsAt: now - 1000,
    createdBy: 'u1',
    createdAt: now,
  });
  await createPoll({
    messageId: 'm2',
    guildId: G,
    channelId: CH,
    question: 'Q',
    options: ['A'],
    multiple: false,
    maxVotes: 0,
    endsAt: null,
    createdBy: 'u1',
    createdAt: now,
  });

  const due = await duePolls(now);
  assert.ok(due.some((p) => p.message_id === 'm1'));
  assert.ok(!due.some((p) => p.message_id === 'm2'));

  await deletePoll('m1');
  assert.equal(await getPoll('m1'), null);

  await clearGuildPolls(G);
  assert.equal(await getPoll('m2'), null);
});
