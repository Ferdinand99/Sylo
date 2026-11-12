// The DM questionnaire when things go wrong or are asked of it from outside: a failing Post or
// preview, answers that need cleaning or a check of their own, keep with a lowered limit, and
// cancelQuestionnaire().
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetQuestionnaires,
  cancelQuestionnaire,
  cutAtGrapheme,
  handleQuestionnaireMessage,
  hasActiveQuestionnaire,
  looksLikeQuestionnairePrompt,
  startQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';

const USER = '700000000000000101';

const QUESTIONS = [
  { id: 'about', label: 'About me', prompt: 'Tell us.', required: true, maxLength: 20 },
  { id: 'likes', label: 'Likes', prompt: '', required: false, maxLength: 50 },
];

function dmOf() {
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  const user = { id: USER, send: async (payload) => sent.push(payload) && { channel } };
  const client = {};
  const say = (content) =>
    handleQuestionnaireMessage({ author: { id: USER, bot: false }, content, client, channel });
  return { user, sent, say, client };
}

const buttonIds = (payload) => payload.components[0].toJSON().components.map((c) => c.custom_id);

function press(dm, customId) {
  const log = { updates: [], edits: [] };
  const interaction = {
    customId,
    user: { id: USER },
    client: dm.client,
    isRepliable: () => true,
    update: async (payload) => log.updates.push(payload),
    message: { edit: async (payload) => log.edits.push(payload) },
  };
  return { interaction, log };
}

async function reviewSession(dm, extra = {}) {
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    review: (answers) => ({ embeds: [{ description: JSON.stringify(answers) }] }),
    onComplete: async () => 'Posted!',
    ...extra,
  });
  await dm.say('About');
  await dm.say('Likes');
}

beforeEach(() => _resetQuestionnaires());

test('a failing onComplete is reported, and the session comes back at the preview with the answers kept', async () => {
  const dm = dmOf();
  const attempts = [];
  await reviewSession(dm, {
    onComplete: async (answers) => {
      attempts.push(answers);
      if (attempts.length === 1) throw new Error('boom');
      return 'Posted at last!';
    },
  });
  const [ok] = buttonIds(dm.sent.at(-1));
  const first = press(dm, ok);
  await routeComponent(first.interaction);
  assert.match(first.log.edits.at(-1).content, /Something went wrong.*answers are kept/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true, 'the session is back');
  const again = dm.sent.at(-1);
  assert.deepEqual(again.embeds[0], { description: JSON.stringify({ about: 'About', likes: 'Likes' }) });
  const [newOk] = buttonIds(again);
  assert.notEqual(newOk, ok, 'the old button is dead, the new preview has its own');
  const second = press(dm, newOk);
  await routeComponent(second.interaction);
  assert.deepEqual(attempts[1], attempts[0], 'the same answers were tried again');
  assert.equal(second.log.edits.at(-1).content, 'Posted at last!');
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
});

test('onComplete can report a failure with { ok: false, message } and the member can retry', async () => {
  const dm = dmOf();
  let calls = 0;
  await reviewSession(dm, {
    onComplete: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, message: 'The channel is not set up.' } : 'Fine.';
    },
  });
  const first = press(dm, buttonIds(dm.sent.at(-1))[0]);
  await routeComponent(first.interaction);
  assert.equal(first.log.edits.at(-1).content, 'The channel is not set up. Your answers are kept.');
  const second = press(dm, buttonIds(dm.sent.at(-1))[0]);
  await routeComponent(second.interaction);
  assert.equal(second.log.edits.at(-1).content, 'Fine.');
});

test('without a review, a failure reopens the last question with the earlier answers kept', async () => {
  const dm = dmOf();
  let got = null;
  let calls = 0;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async (answers) => {
      got = answers;
      calls += 1;
      return calls === 1 ? { ok: false, message: 'Not now.' } : 'Done!';
    },
  });
  await dm.say('About');
  await dm.say('Likes');
  assert.match(dm.sent.at(-1).content, /Not now\. Send your last answer again/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  await dm.say('Likes again');
  assert.deepEqual(got, { about: 'About', likes: 'Likes again' });
  assert.equal(dm.sent.at(-1).content, 'Done!');
});

test('if the preview cannot be updated, Post still completes and the result is sent as a message', async () => {
  const dm = dmOf();
  let completed = 0;
  await reviewSession(dm, {
    onComplete: async () => {
      completed += 1;
      return 'Posted!';
    },
  });
  const { interaction } = press(dm, buttonIds(dm.sent.at(-1))[0]);
  interaction.update = async () => {
    throw new Error('Unknown interaction');
  };
  await routeComponent(interaction);
  assert.equal(completed, 1);
  assert.equal(dm.sent.at(-1).content, 'Posted!');
  assert.equal(hasActiveQuestionnaire('discord', USER), false, 'no stuck session');
});

test('if the preview cannot be shown, the member is asked for the last answer again', async () => {
  const dm = dmOf();
  let first = true;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    review: () => {
      if (first) {
        first = false;
        throw new Error('guild unavailable');
      }
      return { embeds: [{ description: 'ok' }] };
    },
    onComplete: async () => 'Done',
  });
  await dm.say('About');
  await dm.say('Likes');
  assert.match(dm.sent.at(-1).content, /could not show the preview/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  await dm.say('Likes');
  assert.match(dm.sent.at(-1).content, /Happy with this\?/, 'the second try shows the preview');
});

test('a message that comes while Post is being worked on is not treated as an answer', async () => {
  const dm = dmOf();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await reviewSession(dm, {
    onComplete: async () => {
      await gate;
      return 'Posted!';
    },
  });
  const click = press(dm, buttonIds(dm.sent.at(-1))[0]);
  const running = routeComponent(click.interaction);
  await new Promise((r) => setTimeout(r, 10));
  await dm.say('hello?'); // no throw, and no answer taken
  release();
  await running;
  assert.equal(click.log.edits.at(-1).content, 'Posted!');
});

test('keep cuts the old answer to the current limit, with an ellipsis, on a grapheme boundary', async () => {
  const dm = dmOf();
  let got = null;
  const family = ['👨', '👩', '👧'].join(String.fromCodePoint(0x200d));
  await startQuestionnaire({
    user: dm.user,
    questions: [{ id: 'a', label: 'A', required: true, maxLength: 7 }],
    prefill: { a: `abc${family}def` },
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('keep');
  assert.equal(got.a, 'abc…', 'the whole family emoji is dropped, not half of it');
  assert.equal(cutAtGrapheme('abcdef', 6), 'abcdef');
  assert.equal(cutAtGrapheme('abcdefg', 6), 'abcde…');
  assert.equal(cutAtGrapheme('', 3), '');
});

test('normalise cleans every typed answer; one that is empty afterwards is asked again', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: [{ id: 'a', label: 'A', required: true, maxLength: 20 }],
    normalise: (text) => text.replace(/@everyone/g, '').trim(),
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('@everyone');
  assert.match(dm.sent.at(-1).content, /Nothing was left of that answer/);
  assert.equal(got, null);
  await dm.say('@everyone hello');
  assert.deepEqual(got, { a: 'hello' });
});

test('a question can refuse an answer with its own message, and is asked again', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: [
      {
        id: 'colour',
        label: 'Colour',
        required: true,
        maxLength: 10,
        validate: (answer) => (['red', 'blue'].includes(answer) ? null : 'Choose red or blue.'),
      },
    ],
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('green');
  assert.equal(dm.sent.at(-1).content, 'Choose red or blue.');
  assert.equal(got, null);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  await dm.say('blue');
  assert.deepEqual(got, { colour: 'blue' });
});

test('an async validate works, and a kept answer is validated too', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: [
      {
        id: 'a',
        label: 'A',
        required: true,
        maxLength: 10,
        validate: async (value) => (value === 'old' ? 'Not "old" any more.' : null),
      },
    ],
    prefill: { a: 'old' },
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('keep');
  assert.equal(dm.sent.at(-1).content, 'Not "old" any more.');
  await dm.say('new');
  assert.deepEqual(got, { a: 'new' });
});

test('cancelQuestionnaire ends a session from outside, calls onCancel with the reason, and tells the member', async () => {
  const dm = dmOf();
  const reasons = [];
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async () => {},
    onCancel: (reason) => reasons.push(reason),
  });
  assert.equal(cancelQuestionnaire('someone-else', 'module off'), false);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  assert.equal(cancelQuestionnaire(USER, 'module off'), true);
  assert.deepEqual(reasons, ['module off']);
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
  assert.match(dm.sent.at(-1).content, /questionnaire was stopped/);
  assert.equal(await dm.say('late'), false);
  assert.equal(cancelQuestionnaire(USER), false, 'nothing left to cancel');
});

test('cancelQuestionnaire can name a platform and stay silent; the default reason is cancel', async () => {
  const dm = dmOf();
  const reasons = [];
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async () => {},
    onCancel: (reason) => reasons.push(reason),
  });
  const before = dm.sent.length;
  assert.equal(cancelQuestionnaire(USER, 'x', { platform: 'fluxer' }), false, 'another platform');
  assert.equal(cancelQuestionnaire(USER, undefined, { platform: 'discord', notify: false }), true);
  assert.equal(dm.sent.length, before, 'no DM');
  assert.deepEqual(reasons, ['cancel']);
});

test('the questions and the preview can be recognised in a message history', () => {
  assert.equal(
    looksLikeQuestionnairePrompt('Intro for **X**.\n\n**Question 1 of 5 · About me**\nTell us.'),
    true
  );
  assert.equal(looksLikeQuestionnairePrompt('**Question 2 of 5 · Likes** (optional)'), true);
  assert.equal(
    looksLikeQuestionnairePrompt('Looks good.\nHappy with this? Choose **Post** or **Start over**.'),
    true
  );
  assert.equal(looksLikeQuestionnairePrompt('Your introduction is posted: https://x'), false);
  assert.equal(looksLikeQuestionnairePrompt(undefined), false);
});
