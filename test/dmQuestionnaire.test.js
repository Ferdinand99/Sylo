// The shared DM questionnaire (src/bot/lib/dmQuestionnaire.js): the order of the questions, skip,
// keep, cancel, the limit on an answer, the timeout, one session per member, the preview buttons.
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_TIMEOUT_MS,
  _resetQuestionnaires,
  handleQuestionnaireMessage,
  hasActiveQuestionnaire,
  startQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';

const USER = '700000000000000001';

const QUESTIONS = [
  { id: 'about', label: 'About me', prompt: 'Tell us about you.', required: true, maxLength: 20 },
  { id: 'likes', label: 'Likes', prompt: 'What do you like?', required: false, maxLength: 50 },
  { id: 'pronouns', label: 'Pronouns', prompt: '', required: false, maxLength: 10 },
];

/** A member's DM: what the bot sent (`sent`), and a way to write as the member. */
function dmOf(userId = USER, { closed = false } = {}) {
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  const user = {
    id: userId,
    send: async (payload) => {
      if (closed) throw new Error('Cannot send messages to this user');
      sent.push(payload);
      return { channel };
    },
  };
  const client = {};
  const say = (content) =>
    handleQuestionnaireMessage({ author: { id: userId, bot: false }, content, client, channel });
  return { user, sent, say, channel, client };
}

beforeEach(() => _resetQuestionnaires());

test('asks the questions in order and hands the answers to onComplete', async () => {
  const dm = dmOf();
  let got = null;
  const started = await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async (answers) => {
      got = answers;
      return 'All saved.';
    },
  });
  assert.deepEqual(started, { ok: true });
  assert.match(dm.sent[0].content, /Question 1 of 3 · About me/);
  assert.match(dm.sent[0].content, /Tell us about you\./);

  assert.equal(await dm.say('I like trains'), true);
  assert.match(dm.sent[1].content, /Question 2 of 3 · Likes/);
  await dm.say('Tea');
  assert.match(dm.sent[2].content, /Question 3 of 3 · Pronouns/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  await dm.say('they/them');

  assert.deepEqual(got, { about: 'I like trains', likes: 'Tea', pronouns: 'they/them' });
  assert.equal(dm.sent.at(-1).content, 'All saved.');
  assert.equal(hasActiveQuestionnaire('discord', USER), false, 'the session ended');
  assert.equal(await dm.say('hello again'), false, 'with no session a DM is not an answer');
});

test('a message with no session is not swallowed', async () => {
  const dm = dmOf();
  assert.equal(await dm.say('hello'), false);
});

test('skip leaves an optional question empty, and is refused on a required one', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('skip');
  assert.match(dm.sent[1].content, /required, so it cannot be skipped/);
  assert.equal(got, null);
  await dm.say('Me');
  await dm.say('SKIP');
  await dm.say('skip');
  assert.deepEqual(got, { about: 'Me', likes: '', pronouns: '' });
});

test('cancel stops the session and calls onCancel', async () => {
  const dm = dmOf();
  const reasons = [];
  let completed = false;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async () => {
      completed = true;
    },
    onCancel: (reason) => reasons.push(reason),
  });
  await dm.say('Me');
  await dm.say('cancel');
  assert.deepEqual(reasons, ['cancel']);
  assert.equal(completed, false);
  assert.match(dm.sent.at(-1).content, /Cancelled/);
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
  assert.equal(await dm.say('hello'), false);
});

test('an answer past the limit is refused and asked again; exactly the limit is accepted', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS.slice(0, 1),
    onComplete: async (answers) => {
      got = answers;
    },
  });
  await dm.say('x'.repeat(21));
  assert.match(dm.sent[1].content, /That is 21 characters, and the limit is 20/);
  assert.equal(got, null);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  await dm.say('x'.repeat(20));
  assert.deepEqual(got, { about: 'x'.repeat(20) });
});

test('an empty message (a file only) is asked for again', async () => {
  const dm = dmOf();
  await startQuestionnaire({ user: dm.user, questions: QUESTIONS, onComplete: async () => {} });
  await dm.say('   ');
  assert.match(dm.sent[1].content, /Please answer with text/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
});

test('prefill is shown as "Current:" and keep keeps it; without one, "keep" is an ordinary answer', async () => {
  const dm = dmOf();
  let got = null;
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    prefill: { about: 'Old about' },
    onComplete: async (answers) => {
      got = answers;
    },
  });
  assert.match(dm.sent[0].content, /Current:\n> Old about/);
  assert.match(dm.sent[0].content, /`keep`/);
  await dm.say('keep');
  assert.doesNotMatch(dm.sent[1].content, /Current:/, 'the second question has nothing to keep');
  await dm.say('keep');
  await dm.say('skip');
  assert.deepEqual(got, { about: 'Old about', likes: 'keep', pronouns: '' });
});

test('one session per member: a second start is refused and sends nothing', async () => {
  const dm = dmOf();
  const other = dmOf('700000000000000002');
  assert.deepEqual(
    await startQuestionnaire({ user: dm.user, questions: QUESTIONS, onComplete: async () => {} }),
    {
      ok: true,
    }
  );
  const again = dmOf();
  const second = await startQuestionnaire({
    user: again.user,
    questions: QUESTIONS,
    onComplete: async () => {},
  });
  assert.deepEqual(second, { ok: false, reason: 'busy' });
  assert.equal(again.sent.length, 0);
  // someone else is free to start
  assert.deepEqual(
    await startQuestionnaire({ user: other.user, questions: QUESTIONS, onComplete: async () => {} }),
    {
      ok: true,
    }
  );
});

test('a member whose DMs are closed gets no session', async () => {
  const dm = dmOf(USER, { closed: true });
  const started = await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    onComplete: async () => {},
  });
  assert.deepEqual(started, { ok: false, reason: 'dm_closed' });
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
  const open = dmOf();
  assert.deepEqual(
    await startQuestionnaire({ user: open.user, questions: QUESTIONS, onComplete: async () => {} }),
    {
      ok: true,
    }
  );
});

test('no questions: nothing to start', async () => {
  const dm = dmOf();
  assert.deepEqual(await startQuestionnaire({ user: dm.user, questions: [], onComplete: async () => {} }), {
    ok: false,
    reason: 'no_questions',
  });
});

test('a session ends after the timeout with no answer', async () => {
  assert.equal(SESSION_TIMEOUT_MS, 10 * 60 * 1000);
  const dm = dmOf();
  const reasons = [];
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    timeoutMs: 30,
    onComplete: async () => {},
    onCancel: (reason) => reasons.push(reason),
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(reasons, ['timeout']);
  assert.match(dm.sent.at(-1).content, /took too long/);
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
  assert.equal(await dm.say('late answer'), false);
});

test('an answer restarts the silence timer', async () => {
  const dm = dmOf();
  const reasons = [];
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS,
    timeoutMs: 80,
    onComplete: async () => {},
    onCancel: (reason) => reasons.push(reason),
  });
  await new Promise((r) => setTimeout(r, 50));
  await dm.say('Me');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(reasons, [], 'still running 100 ms in, because of the answer at 50 ms');
  await dm.say('cancel');
});

// --- the preview and its buttons ----------------------------------------------------------------------

const buttonIds = (payload) => payload.components[0].toJSON().components.map((c) => c.custom_id);

/** A button press on the preview message. */
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
  const completed = [];
  await startQuestionnaire({
    user: dm.user,
    questions: QUESTIONS.slice(0, 2),
    review: (answers) => ({ embeds: [{ description: JSON.stringify(answers) }] }),
    confirmLabel: 'Post',
    restartLabel: 'Start over',
    onComplete: async (answers) => {
      completed.push(answers);
      return 'Posted!';
    },
    ...extra,
  });
  await dm.say('About');
  await dm.say('Likes');
  return completed;
}

test('with a review, the last answer shows a preview with Post and Start over, and nothing is completed yet', async () => {
  const dm = dmOf();
  const completed = await reviewSession(dm);
  const preview = dm.sent.at(-1);
  assert.deepEqual(preview.embeds[0], { description: JSON.stringify({ about: 'About', likes: 'Likes' }) });
  assert.match(preview.content, /\*\*Post\*\* or \*\*Start over\*\*/);
  const labels = preview.components[0].toJSON().components.map((c) => c.label);
  assert.deepEqual(labels, ['Post', 'Start over']);
  assert.equal(completed.length, 0);
  assert.equal(hasActiveQuestionnaire('discord', USER), true);
  // typing in the review step does not change anything
  await dm.say('more text');
  assert.match(dm.sent.at(-1).content, /Use the buttons/);
  assert.equal(completed.length, 0);
});

test('Post runs onComplete once and shows its text on the preview message', async () => {
  const dm = dmOf();
  const completed = await reviewSession(dm);
  const [ok] = buttonIds(dm.sent.at(-1));
  const { interaction, log } = press(dm, ok);
  assert.equal(await routeComponent(interaction), true);
  assert.deepEqual(completed, [{ about: 'About', likes: 'Likes' }]);
  assert.equal(log.edits.at(-1).content, 'Posted!');
  assert.equal(hasActiveQuestionnaire('discord', USER), false);
  // a second press finds nothing
  const second = press(dm, ok);
  await routeComponent(second.interaction);
  assert.equal(completed.length, 1);
  assert.match(second.log.updates[0].content, /no longer active/);
});

test('Start over asks again from the first question, offering the answers so far', async () => {
  const dm = dmOf();
  const completed = await reviewSession(dm);
  const [, redo] = buttonIds(dm.sent.at(-1));
  const { interaction, log } = press(dm, redo);
  await routeComponent(interaction);
  assert.equal(log.updates[0].content, 'Starting over.');
  assert.match(dm.sent.at(-1).content, /Question 1 of 2 · About me/);
  assert.match(dm.sent.at(-1).content, /Current:\n> About/);
  assert.equal(completed.length, 0);
  await dm.say('keep');
  await dm.say('New likes');
  const [newOk] = buttonIds(dm.sent.at(-1));
  await routeComponent(press(dm, newOk).interaction);
  assert.deepEqual(completed, [{ about: 'About', likes: 'New likes' }]);
});

test('a button of an old session is refused', async () => {
  const dm = dmOf();
  await reviewSession(dm);
  const { interaction, log } = press(dm, 'dmq:ok:0123456789ab');
  await routeComponent(interaction);
  assert.match(log.updates[0].content, /no longer active/);
  assert.equal(hasActiveQuestionnaire('discord', USER), true, 'the real session is untouched');
});
