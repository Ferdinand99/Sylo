// A multiple-choice poll with a max-votes cap re-checked its voters on every reaction: one
// reaction-users request per option and one member lookup per reactor and option, each time, with
// the checks overlapping. The check now runs once at a time, at most every few seconds, looks each
// reactor up once and does not count reactors who have left.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { createPoll, getPoll } from '../src/db/polls.js';
import { dispatch } from '../src/modules/dispatch.js';
import { LETTERS, _setMaxVotesCheckMs } from '../src/modules/polls.js';

const G = '900000000000000071';
const CH = '700000000000000711';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (n) => String(200000000000000000n + BigInt(n));

const unknownMember = () => Object.assign(new Error('Unknown Member'), { code: 10007 });

function env({ options, departed, present, memberError = unknownMember }) {
  const calls = { reactionPages: 0, memberFetches: 0 };
  const members = new Map(present.map((uid) => [uid, { id: uid, roles: { cache: new Map() } }]));
  const guild = {
    id: G,
    members: {
      cache: members,
      fetch: async () => {
        calls.memberFetches += 1;
        throw memberError();
      },
    },
  };
  const everyone = [...departed, ...present].map((uid) => [uid, { id: uid, bot: false }]);
  const message = { id: 'poll-msg', partial: false, guild, reactions: { cache: new Map() } };
  for (let i = 0; i < options; i += 1) {
    message.reactions.cache.set(LETTERS[i], {
      emoji: { name: LETTERS[i] },
      count: everyone.length,
      me: true,
      partial: false,
      message,
      users: {
        cache: new Map(),
        fetch: async () => {
          calls.reactionPages += 1;
          return new Map(everyone);
        },
        remove: async () => {},
      },
    });
  }
  return { calls, guild, message };
}

async function newPoll(messageId, options, maxVotes) {
  await createPoll({
    messageId,
    guildId: G,
    channelId: CH,
    question: 'Q',
    options: Array.from({ length: options }, (_, i) => `opt${i}`),
    multiple: true,
    maxVotes,
    endsAt: null,
    createdBy: 'u1',
    createdAt: Date.now(),
  });
}

test('a burst of reactions on a max-votes poll runs one check, not one per reaction', async () => {
  _setMaxVotesCheckMs(400);
  await setGuildModule(G, 'polls', { enabled: true, config: {} });
  const attacker = id(1);
  const departed = Array.from({ length: 30 }, (_, i) => id(100 + i));
  const { calls, message } = env({ options: 20, departed, present: [attacker] });
  message.id = 'poll-burst';
  await newPoll('poll-burst', 20, 40); // 20 options x 31 reactions: the sum passes 40, the real voters never do

  const react = () =>
    dispatch('reactionAdd', G, {
      reaction: message.reactions.cache.get(LETTERS[0]),
      user: { id: attacker, bot: false },
    });
  await Promise.all(Array.from({ length: 10 }, react));

  assert.equal(calls.reactionPages, 20, 'one tally: one page request per option');
  assert.equal(calls.memberFetches, 30, 'each departed reactor is looked up once, not once per option');

  await Promise.all(Array.from({ length: 10 }, react)); // still inside the window
  assert.equal(calls.reactionPages, 20);

  // The reactions that arrived meanwhile share one trailing check (wait for it, with a generous deadline).
  for (let waited = 0; calls.reactionPages < 40 && waited < 10_000; waited += 25) await sleep(25);
  await sleep(150);
  assert.equal(calls.reactionPages, 40);
  assert.equal(calls.memberFetches, 30, 'departed users are remembered, not asked about again');
  assert.ok(await getPoll('poll-burst'), 'accounts that have left do not close the poll');
});

test('the poll closes once enough eligible voters have reacted', async () => {
  _setMaxVotesCheckMs(0);
  const present = Array.from({ length: 3 }, (_, i) => id(500 + i));
  const { calls, message } = env({ options: 2, departed: [id(900)], present });
  message.id = 'poll-close';
  await newPoll('poll-close', 2, 3);
  await dispatch('reactionAdd', G, {
    reaction: message.reactions.cache.get(LETTERS[0]),
    user: { id: present[0], bot: false },
  });
  assert.equal(await getPoll('poll-close'), null, 'three real voters reach max_votes');
  assert.ok(calls.reactionPages >= 2);
});

test('a Fluxer member-not-found error is remembered as departed, like the Discord one', async () => {
  _setMaxVotesCheckMs(0);
  // FluxerError { code: 'MEMBER_NOT_FOUND', cause: { statusCode: 404 } }, and the 404 in `cause` alone.
  const fluxerShapes = [
    () =>
      Object.assign(new Error('Member not found'), { code: 'MEMBER_NOT_FOUND', cause: { statusCode: 404 } }),
    () => Object.assign(new Error('lookup failed'), { cause: { statusCode: 404 } }),
  ];
  for (const [n, memberError] of fluxerShapes.entries()) {
    const gone = [id(1000 + n * 10), id(1001 + n * 10), id(1002 + n * 10)];
    const e = env({ options: 20, departed: gone, present: [id(1)], memberError });
    e.message.id = `poll-fluxer-${n}`;
    await newPoll(`poll-fluxer-${n}`, 20, 30);
    const react = () =>
      dispatch('reactionAdd', G, {
        reaction: e.message.reactions.cache.get(LETTERS[0]),
        user: { id: id(1), bot: false },
      });
    await react();
    await react();
    assert.equal(e.calls.memberFetches, 3, `shape ${n}: asked once, then remembered`);
  }
});

test('only Unknown Member is remembered as departed; a failed lookup is asked again and is not "left"', async () => {
  _setMaxVotesCheckMs(0);
  const react = (message, user) =>
    dispatch('reactionAdd', G, {
      reaction: message.reactions.cache.get(LETTERS[0]),
      user: { id: user, bot: false },
    });
  const gone = [id(700), id(701), id(702)];

  // Unknown Member: asked once, then remembered.
  const a = env({ options: 20, departed: gone, present: [id(1)] });
  a.message.id = 'poll-gone';
  await newPoll('poll-gone', 20, 30);
  await react(a.message, id(1));
  await react(a.message, id(1));
  assert.equal(a.calls.memberFetches, 3);

  // A server error: asked again each time, and the reactors still count (no vote roles are set), so
  // a poll whose cap is met closes even though the lookups failed.
  const strangers = [id(800), id(801), id(802)];
  const b = env({
    options: 20,
    departed: strangers,
    present: [id(1)],
    memberError: () => new Error('HTTP 503'),
  });
  b.message.id = 'poll-503';
  await newPoll('poll-503', 20, 30);
  await react(b.message, id(1));
  await react(b.message, id(1));
  assert.equal(b.calls.memberFetches, 6);
  assert.ok(await getPoll('poll-503'), 'three voters do not reach 30');

  const c = env({
    options: 2,
    departed: strangers,
    present: [id(1)],
    memberError: () => new Error('HTTP 503'),
  });
  c.message.id = 'poll-503-close';
  await newPoll('poll-503-close', 2, 4);
  await react(c.message, id(1));
  assert.equal(await getPoll('poll-503-close'), null, 'failed lookups are not treated as members who left');
});
