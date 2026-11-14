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

function env({ options, departed, present }) {
  const calls = { reactionPages: 0, memberFetches: 0 };
  const members = new Map(present.map((uid) => [uid, { id: uid, roles: { cache: new Map() } }]));
  const guild = {
    id: G,
    members: {
      cache: members,
      fetch: async () => {
        calls.memberFetches += 1;
        throw new Error('Unknown Member');
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

  await sleep(900); // the reactions that arrived meanwhile share one trailing check
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
