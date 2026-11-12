// A questionnaire answered in DM, one question at a time. Shared by every feature that asks a
// member a few questions: the Introductions module today, applications later.
//
//   const started = await startQuestionnaire({
//     user, platform, questions, prefill,
//     review: (answers) => ({ embeds: [...] }),     // optional preview with Confirm / Start over
//     normalise: (text) => text.trim(),             // optional: clean every typed answer first
//     onComplete: async (answers) => 'Posted!',     // runs when the member confirms (or, with no
//                                                   // review, after the last answer). Return a text
//                                                   // to show, or { ok: false, message } / throw
//                                                   // to report a failure (see below). Add
//                                                   // final: true when trying again cannot help:
//                                                   // the session then ends.
//     onCancel: async (reason) => {},               // 'cancel' | 'timeout' | what cancelQuestionnaire got
//   });
//   // started = { ok: true } | { ok: false, reason: 'busy' | 'dm_closed' | 'no_questions' }
//
// A question is { id, label, prompt?, required?, maxLength?, validate?, normalise?, show?, hint?, exact? }.
// `validate(answer)` may return a text (the answer is refused, the text is shown and the question
// asked again) or null. `normalise(text)` turns what the member typed into the stored answer (option
// numbers into option ids, "y" into "yes") and may return { error } to refuse it; it does not run on a
// kept answer, which is stored already. `show(answer)` writes a stored answer as "Current:" in words.
// `hint` replaces the line "Up to N characters."; `exact` turns the length check off (the answer is a
// stored form, not typed text).
//
// The DM handler (bot/events/dmTickets.js) offers every direct message to
// handleQuestionnaireMessage() first: while a member has a session, what they write is an answer
// (or `skip`, `keep`, `cancel`) and never opens a modmail ticket.
//
// Rules the engine keeps:
//   - one session per member at a time, across every server of a platform
//   - a session ends after 10 minutes without an answer
//   - an answer longer than the question's maxLength, or empty once normalised, is refused and asked
//     again
//   - `skip` leaves an optional question empty, `keep` keeps the answer shown as "Current:" (cut to
//     the current limit), `cancel` stops
//   - when onComplete fails, the session comes back with the answers kept (the preview again, or the
//     last question) so the member can try again
//   - cancelQuestionnaire() ends a session from outside (module switched off, member left ...)
//   - sessions live in memory: a restart simply cancels them (dmTickets.js tells the member when a
//     late answer arrives, see looksLikeQuestionnairePrompt)
//
// Buttons: on Discord they are real buttons. On Fluxer the component bridge turns them into
// reactions (platform/components.js), so the engine builds ordinary discord.js buttons and gives
// each one an emoji.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { registerComponent } from './components.js';
import { platformOfClient } from '../../platform/platformOf.js';
import { log } from '../../lib/log.js';

/** Silence after which a session ends. */
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

const PREFIX = 'dmq:';
const NO_MENTIONS = { parse: [] };
const CURRENT_SHOWN = 300;

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {{ id: string, label: string, prompt?: string, required?: boolean, maxLength?: number,
 *   hint?: string, exact?: boolean, show?: (answer: string) => string,
 *   normalise?: (text: string) => string | { error: string },
 *   validate?: (answer: string) => Promise<string | null | undefined> | string | null | undefined }} Question
 * @typedef {Object} Session
 * @property {string} key
 * @property {string} token         tells a button of this session from a stale one
 * @property {any} user
 * @property {Question[]} questions
 * @property {Record<string, string>} answers
 * @property {Record<string, string>} prefill
 * @property {number} index
 * @property {'asking' | 'review' | 'done'} state
 * @property {any} channel          the DM channel, once the member has written
 * @property {boolean} ended
 */

const keyOf = (platform, userId) => `${platform}:${userId}`;

/** Is this member in a questionnaire right now? */
export const hasActiveQuestionnaire = (platform, userId) => sessions.has(keyOf(platform, userId));

/**
 * Does this message text look like something the questionnaire sent (a question or the preview)?
 * After a restart a session is gone, so the DM handler uses this on the message before a late
 * answer to tell the member, instead of sending the answer to modmail.
 */
export const looksLikeQuestionnairePrompt = (content) =>
  /(^|\n)\*\*Question \d+ of \d+ · /.test(String(content ?? '')) ||
  /(^|\n)Happy with this\? Choose \*\*/.test(String(content ?? ''));

/** Tests only: drop every session and its timer. */
export function _resetQuestionnaires() {
  for (const session of sessions.values()) clearTimeout(session.timer);
  sessions.clear();
}

const cap = (n, fallback) => (Number.isInteger(n) && n > 0 ? n : fallback);

/**
 * Cut to at most `max` UTF-16 units, ending in "…", on a grapheme boundary (never in the middle of
 * an emoji or an accented letter).
 */
export function cutAtGrapheme(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let out = '';
  for (const { segment } of segmenter.segment(value)) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** Send to the member's DM: the channel once known, else the user. */
function deliver(session, payload) {
  return (session.channel ?? session.user).send({ allowedMentions: NO_MENTIONS, ...payload });
}

const quoted = (text) =>
  String(text)
    .slice(0, CURRENT_SHOWN)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n') + (String(text).length > CURRENT_SHOWN ? '…' : '');

/** The text that asks question `index`. */
function promptFor(session) {
  const { questions, index, prefill } = session;
  const q = questions[index];
  const lines = [
    `**Question ${index + 1} of ${questions.length} · ${q.label}**${q.required ? '' : ' (optional)'}`,
  ];
  if (q.prompt) lines.push(q.prompt);
  const limit = cap(q.maxLength, 1024);
  const rules = [q.hint ?? `Up to ${limit} characters.`];
  if (!q.required) rules.push('Type `skip` to leave it empty.');
  rules.push('Type `cancel` to stop.');
  lines.push(rules.join(' '));
  const current = prefill[q.id];
  if (current)
    lines.push(`Current:\n${quoted(q.show ? q.show(current) : current)}\nType \`keep\` to keep it.`);
  return lines.join('\n');
}

function armTimer(session, timeoutMs) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.ended) return;
    endSession(session);
    void Promise.resolve(session.onCancel?.('timeout')).catch((err) =>
      log.error('questionnaire', 'onCancel failed:', err.message)
    );
    deliver(session, {
      content: 'That took too long, so I stopped. Nothing was changed. Start again whenever you like.',
    }).catch(() => {});
  }, timeoutMs);
  session.timer.unref?.();
}

function endSession(session) {
  session.ended = true;
  clearTimeout(session.timer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
}

/**
 * End a member's session from outside, for example when the module it belongs to is switched off,
 * the member leaves the server or erases their data. Calls the session's onCancel with `reason`.
 * @param {string} userId
 * @param {string} [reason]
 * @param {{ platform?: 'discord' | 'fluxer', scope?: string, scopePrefix?: string, notify?: boolean }} [opts]
 *   without a platform, every platform's session of that user id ends; `scope` limits it to sessions
 *   started with that scope, `scopePrefix` to those whose scope starts with it; `notify: false` skips
 *   the DM that tells the member
 * @returns {boolean} whether there was a session
 */
export function cancelQuestionnaire(
  userId,
  reason = 'cancel',
  { platform = null, scope = null, scopePrefix = null, notify = true } = {}
) {
  return stopSessions(
    (session) =>
      session.user.id === userId &&
      (!platform || session.platform === platform) &&
      (!scope || session.scope === scope) &&
      (!scopePrefix || String(session.scope ?? '').startsWith(scopePrefix)),
    reason,
    notify
  );
}

/**
 * End every session that was started with this `scope` (a string the feature chose, for example one
 * per server), for example when its module is switched off for that server.
 * @param {string} scope
 * @param {string} [reason]
 * @param {{ notify?: boolean, prefix?: boolean }} [opts]  `prefix`: every session whose scope starts with it
 * @returns {boolean} whether there was a session
 */
export function cancelQuestionnairesOf(scope, reason = 'cancel', { notify = true, prefix = false } = {}) {
  return stopSessions(
    (session) => (prefix ? String(session.scope ?? '').startsWith(scope) : session.scope === scope),
    reason,
    notify
  );
}

function stopSessions(matches, reason, notify) {
  let found = false;
  for (const session of [...sessions.values()]) {
    // Not one that is being completed: its onComplete is already running and cannot be taken back.
    if (!matches(session) || session.state === 'done') continue;
    found = true;
    endSession(session);
    void Promise.resolve(session.onCancel?.(reason)).catch((err) =>
      log.error('questionnaire', 'onCancel failed:', err.message)
    );
    if (notify) {
      deliver(session, { content: 'This questionnaire was stopped, so nothing was changed.' }).catch(
        () => {}
      );
    }
  }
  return found;
}

function buttons(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}ok:${session.token}`)
      .setLabel(session.confirmLabel)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}redo:${session.token}`)
      .setLabel(session.restartLabel)
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Start a questionnaire in the member's DMs.
 * @param {object} opts
 * @param {any} opts.user  the member; needs send()
 * @param {'discord' | 'fluxer'} [opts.platform]
 * @param {Question[]} opts.questions
 * @param {Record<string, string>} [opts.prefill]  current answers, offered with `keep`
 * @param {string} [opts.header]  text before the first question
 * @param {(answers: Record<string, string>) => any} [opts.review]  a message payload previewing the result
 * @param {(text: string) => string} [opts.normalise]  cleans every typed answer (and a kept one) first
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.restartLabel]
 * @param {(answers: Record<string, string>) => Promise<string | { ok: false, message?: string } | void> | string | void} opts.onComplete
 * @param {(reason: string) => any} [opts.onCancel]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.scope]  a label for cancelQuestionnairesOf()
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'busy' | 'dm_closed' | 'no_questions' }>}
 */
export async function startQuestionnaire({
  user,
  platform = 'discord',
  questions,
  prefill = {},
  header = '',
  review = null,
  normalise = null,
  confirmLabel = 'Post',
  restartLabel = 'Start over',
  onComplete,
  onCancel = null,
  timeoutMs = SESSION_TIMEOUT_MS,
  scope = null,
}) {
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, reason: 'no_questions' };
  const key = keyOf(platform, user.id);
  if (sessions.has(key)) return { ok: false, reason: 'busy' };

  /** @type {Session} */
  const session = {
    key,
    token: randomBytes(6).toString('hex'),
    user,
    platform,
    questions,
    answers: {},
    prefill: { ...prefill },
    index: 0,
    state: 'asking',
    channel: null,
    ended: false,
    review,
    normalise,
    confirmLabel,
    restartLabel,
    onComplete,
    onCancel,
    timeoutMs,
    scope,
    queue: Promise.resolve(),
    timer: null,
  };
  // Reserved before the first send, so a second start in the same instant sees it.
  sessions.set(key, session);
  try {
    await deliver(session, { content: `${header ? `${header}\n\n` : ''}${promptFor(session)}` });
  } catch {
    endSession(session);
    return { ok: false, reason: 'dm_closed' };
  }
  armTimer(session, timeoutMs);
  return { ok: true };
}

/**
 * Offer a direct message to the member's session.
 * @param {any} message  a DM from a person
 * @returns {Promise<boolean>} true when the message was an answer (the caller must not handle it)
 */
export async function handleQuestionnaireMessage(message) {
  const session = sessions.get(keyOf(platformOfClient(message.client), message.author?.id));
  if (!session) return false;
  session.channel = message.channel ?? session.channel;
  // One message at a time per member, in the order they arrived.
  const run = session.queue.then(() => handleAnswer(session, message));
  session.queue = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    log.error('questionnaire', 'could not handle an answer:', err.message);
  }
  return true;
}

const reply = (session, content) => deliver(session, { content }).catch(() => {});

async function handleAnswer(session, message) {
  if (session.ended) return;
  armTimer(session, session.timeoutMs);
  const text = String(message.content ?? '').trim();
  const word = text.toLowerCase();

  if (word === 'cancel' && session.state === 'done') {
    // onComplete is running: whatever it does (a post, a save) cannot be taken back from here.
    await reply(session, 'That is already being completed, so it is too late to cancel.');
    return;
  }
  if (word === 'cancel') {
    endSession(session);
    await Promise.resolve(session.onCancel?.('cancel')).catch((err) =>
      log.error('questionnaire', 'onCancel failed:', err.message)
    );
    await reply(session, 'Cancelled. Nothing was changed.');
    return;
  }
  if (session.state === 'review') {
    await reply(session, 'Use the buttons (or reactions) under the preview, or type `cancel` to stop.');
    return;
  }
  // Working on the confirmation: nothing to answer.
  if (session.state !== 'asking') return;

  const q = session.questions[session.index];
  const limit = cap(q.maxLength, 1024);
  if (word === 'skip') {
    if (q.required) {
      await reply(session, 'That question is required, so it cannot be skipped.');
      return;
    }
    session.answers[q.id] = '';
    await advance(session);
    return;
  }

  let value;
  if (word === 'keep' && session.prefill[q.id]) {
    // The old answer must still fit the question as it is now.
    value = session.normalise ? session.normalise(session.prefill[q.id]) : session.prefill[q.id];
    if (!value && q.required) {
      await reply(
        session,
        'The earlier answer is empty now, and this question is required. Please write one.'
      );
      return;
    }
    if (!q.exact) value = cutAtGrapheme(value, limit);
  } else {
    if (!text) {
      await reply(session, 'Please answer with text.');
      return;
    }
    value = session.normalise ? session.normalise(text) : text;
    if (!value) {
      await reply(
        session,
        'Nothing was left of that answer once mentions and invisible characters were removed. Please write it again.'
      );
      return;
    }
    if (q.normalise) {
      let parsed;
      try {
        parsed = q.normalise(value);
      } catch (err) {
        log.error('questionnaire', `normalise failed for question ${q.id}: ${err.message}`);
        parsed = { error: 'Could not read that answer, please try again.' };
      }
      if (parsed && typeof parsed === 'object') {
        await reply(session, parsed.error || 'That answer is not valid. Please try again.');
        return;
      }
      value = String(parsed ?? '');
    }
    if (!q.exact && value.length > limit) {
      await reply(
        session,
        `That is ${value.length} characters, and the limit is ${limit}. Shorten it and send it again.`
      );
      return;
    }
  }
  let refusal;
  try {
    refusal = value ? await q.validate?.(value) : null;
  } catch (err) {
    // The answer itself is never logged.
    log.error('questionnaire', `validate failed for question ${q.id}: ${err.message}`);
    await reply(session, 'Could not check that answer, please try again.');
    return;
  }
  if (refusal) {
    await reply(session, refusal);
    return;
  }
  session.answers[q.id] = value;
  await advance(session);
}

/** Send the preview and wait for the member's choice. */
async function showReview(session) {
  const preview = await session.review({ ...session.answers });
  await deliver(session, {
    ...preview,
    content: [
      preview?.content,
      `Happy with this? Choose **${session.confirmLabel}** or **${session.restartLabel}**.`,
    ]
      .filter(Boolean)
      .join('\n'),
    components: [buttons(session)],
  });
  // Only once it is on screen: with no preview, there is nothing to press.
  session.state = 'review';
}

/** Move to the next question, or to the end. */
async function advance(session) {
  session.index += 1;
  if (session.index < session.questions.length) {
    await deliver(session, { content: promptFor(session) });
    return;
  }
  if (!session.review) {
    await complete(session, null);
    return;
  }
  try {
    await showReview(session);
  } catch (err) {
    // Back to the last question, so the member can send that answer again (or cancel).
    log.error('questionnaire', 'could not show the preview:', err.message);
    reopenLastQuestion(session);
    await reply(session, 'I could not show the preview. Send your last answer again, or type `cancel`.');
  }
}

/** Back to the last question, with its answer removed. */
function reopenLastQuestion(session) {
  session.index = session.questions.length - 1;
  delete session.answers[session.questions[session.index].id];
  session.state = 'asking';
}

/**
 * Run onComplete and tell the member the result. `editable` is the preview message, when there is
 * one. A failure (a throw, or { ok: false }) brings the session back with the answers kept.
 */
async function complete(session, editable) {
  // The session stays registered while onComplete runs, so a DM that arrives meanwhile is still
  // swallowed (and ignored) rather than going to modmail.
  session.state = 'done';
  armTimer(session, session.timeoutMs); // a safety net if onComplete never returns
  const say = async (content) => {
    if (editable) {
      try {
        await editable.edit({ content, embeds: [], components: [] });
        return;
      } catch {
        // the message cannot be edited any more: say it as a new message
      }
    }
    await deliver(session, { content });
  };
  let failure = null;
  let result;
  try {
    result = await session.onComplete({ ...session.answers });
  } catch (err) {
    log.error('questionnaire', 'onComplete failed:', err.message);
    failure = 'Something went wrong, so nothing was changed.';
  }
  if (!failure && result && typeof result === 'object' && result.ok === false) {
    failure = result.message || 'Something went wrong, so nothing was changed.';
  }
  if (!failure) {
    endSession(session);
    await say(typeof result === 'string' && result ? result : 'Done.').catch(() => {});
    return;
  }
  // A failure that trying again cannot fix (the member left, the module is off): end the session.
  if (result && typeof result === 'object' && result.final === true) {
    endSession(session);
    await say(failure).catch(() => {});
    return;
  }

  // Failed: keep the answers and give the member another try.
  if (session.ended) {
    // cancelled meanwhile
    await say(`${failure} Start again when you like.`).catch(() => {});
    return;
  }
  session.token = randomBytes(6).toString('hex');
  armTimer(session, session.timeoutMs);
  if (session.review) {
    await say(`${failure} Your answers are kept.`).catch(() => {});
    try {
      await showReview(session);
    } catch (err) {
      log.error('questionnaire', 'could not show the preview again:', err.message);
      reopenLastQuestion(session);
      await reply(session, 'Send your last answer again to try once more, or type `cancel`.');
    }
    return;
  }
  reopenLastQuestion(session);
  await say(`${failure} Send your last answer again to try once more, or type \`cancel\`.`).catch(() => {});
}

// --- the buttons under the preview -------------------------------------------------------------

async function handleButton(interaction) {
  const [, action, token] = interaction.customId.split(':');
  const platform = platformOfClient(interaction.client ?? interaction.message?.client);
  const session = sessions.get(keyOf(platform, interaction.user.id));
  if (!session || session.token !== token || session.state !== 'review') {
    await interaction.update({
      content: 'This preview is no longer active. Start again from the server when you are ready.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'redo') {
    // Starting over: what they said so far becomes the "Current:" they can keep.
    session.prefill = Object.fromEntries(Object.entries(session.answers).filter(([, v]) => v));
    session.answers = {};
    session.index = 0;
    session.state = 'asking';
    armTimer(session, session.timeoutMs);
    await interaction
      .update({ content: 'Starting over.', embeds: [], components: [] })
      .catch((err) => log.warn('questionnaire', `could not update the preview: ${err.message}`));
    await deliver(session, { content: promptFor(session) });
    return;
  }

  if (action === 'ok') {
    session.state = 'done'; // a second press while this one runs finds no review
    // If the preview cannot be updated (an expired interaction), the result still follows as a message.
    const updated = await interaction
      .update({ content: 'Working on it…', embeds: [], components: [] })
      .then(() => true)
      .catch((err) => {
        log.warn('questionnaire', `could not update the preview: ${err.message}`);
        return false;
      });
    await complete(session, updated ? interaction.message : null);
  }
}

registerComponent('questionnaire', PREFIX, handleButton);
