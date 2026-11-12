// What a question can add to the shared DM questionnaire (bot/lib/dmQuestionnaire.js) for features such as
// Applications: its own reading of a typed answer (normalise, which may refuse it), a stored form that
// is shown in words (show), its own hint, and answers that are not typed text (exact).
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetQuestionnaires,
  handleQuestionnaireMessage,
  startQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const U = '700000000000000030';
let env;
let member;
let sent;
let say;
beforeEach(() => {
  _resetQuestionnaires();
  dropFakeClient();
  env = fakeIntroGuild();
  member = fakeMember(env.guild, U);
  sent = member.user.dms;
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  member.user.send = async (payload) => sent.push(payload) && { channel };
  say = (content) =>
    handleQuestionnaireMessage({ author: member.user, content, client: env.client, channel });
});

const colours = {
  id: 'colour',
  label: 'Colour',
  prompt: '**1.** Red\n**2.** Blue',
  hint: 'Answer with a number.',
  exact: true,
  required: true,
  normalise: (text) => {
    const n = Number(text);
    return n === 1 ? 'red' : n === 2 ? 'blue' : { error: 'Pick 1 or 2.' };
  },
  show: (stored) => ({ red: 'Red', blue: 'Blue' })[stored] ?? stored,
  validate: (stored) => (['red', 'blue'].includes(stored) ? null : 'Not a colour.'),
};

test('a question reads the typed answer itself, may refuse it, and its own hint replaces the length line', async () => {
  const done = [];
  await startQuestionnaire({
    user: member.user,
    questions: [colours],
    onComplete: async (a) => done.push(a) && 'ok',
  });
  assert.match(sent[0].content, /Answer with a number\./);
  assert.doesNotMatch(sent[0].content, /Up to \d+ characters/);
  await say('3');
  assert.equal(sent.at(-1).content, 'Pick 1 or 2.');
  assert.deepEqual(done, [], 'a refused answer is asked again, not stored');
  await say('2');
  assert.deepEqual(done, [{ colour: 'blue' }], 'what is stored is what normalise returned');
});

test('an exact answer is not held to the typed length, and a throwing normalise asks again', async () => {
  const long = { ...colours, id: 'x', maxLength: 1, validate: undefined, normalise: () => 'red'.repeat(5) };
  const done = [];
  await startQuestionnaire({
    user: member.user,
    questions: [long],
    onComplete: async (a) => done.push(a) && 'ok',
  });
  await say('whatever');
  assert.deepEqual(done, [{ x: 'redredredredred' }]);

  _resetQuestionnaires();
  const broken = {
    ...colours,
    id: 'y',
    normalise: () => {
      throw new Error('boom');
    },
  };
  await startQuestionnaire({ user: member.user, questions: [broken], onComplete: async () => 'ok' });
  await say('1');
  assert.match(sent.at(-1).content, /Could not read that answer/);
});

test('"keep" offers the earlier answer in words, stores it as it was, and skips normalise', async () => {
  const done = [];
  let normalised = 0;
  const q = { ...colours, normalise: (t) => ((normalised += 1), colours.normalise(t)) };
  await startQuestionnaire({
    user: member.user,
    questions: [q],
    prefill: { colour: 'blue' },
    onComplete: async (a) => done.push(a) && 'ok',
  });
  assert.match(sent[0].content, /Current:\n> Blue\nType `keep`/);
  await say('keep');
  assert.deepEqual(done, [{ colour: 'blue' }]);
  assert.equal(normalised, 0, 'a kept answer is stored already and is not read again');
});

test('a kept answer that is no longer valid is refused by validate', async () => {
  const done = [];
  await startQuestionnaire({
    user: member.user,
    questions: [colours],
    prefill: { colour: 'green' },
    onComplete: async (a) => done.push(a) && 'ok',
  });
  await say('keep');
  assert.equal(sent.at(-1).content, 'Not a colour.');
  assert.deepEqual(done, []);
});
