// A questionnaire answered in DM, one question at a time. Shared by every feature that asks a
// member a few questions: the Introductions module today, applications later.
//
//   const started = await startQuestionnaire({
//     user, platform, questions, prefill,
//     review: (answers) => ({ embeds: [...] }),     // optional preview with Confirm / Start over
//     onComplete: async (answers) => 'Posted!',     // runs when the member confirms (or, with no
//                                                   // review, after the last answer)
//     onCancel: async (reason) => {},               // 'cancel' | 'timeout'
//   });
//   // started = { ok: true } | { ok: false, reason: 'busy' | 'dm_closed' | 'no_questions' }
//
// The DM handler (bot/events/dmTickets.js) offers every direct message to
// handleQuestionnaireMessage() first: while a member has a session, what they write is an answer
// (or `skip`, `keep`, `cancel`) and never opens a modmail ticket.
//
// Rules the engine keeps:
//   - one session per member at a time, across every server of a platform
//   - a session ends after 10 minutes without an answer
//   - an answer longer than the question's maxLength is refused and asked again
//   - `skip` leaves an optional question empty, `keep` keeps the answer shown as "Current:",
//     `cancel` stops
//   - sessions live in memory: a restart simply cancels them
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
 * @typedef {{ id: string, label: string, prompt?: string, required?: boolean, maxLength?: number }} Question
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

/** Tests only: drop every session and its timer. */
export function _resetQuestionnaires() {
  for (const session of sessions.values()) clearTimeout(session.timer);
  sessions.clear();
}

const cap = (n, fallback) => (Number.isInteger(n) && n > 0 ? n : fallback);

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
  const rules = [`Up to ${limit} characters.`];
  if (!q.required) rules.push('Type `skip` to leave it empty.');
  rules.push('Type `cancel` to stop.');
  lines.push(rules.join(' '));
  const current = prefill[q.id];
  if (current) lines.push(`Current:\n${quoted(current)}\nType \`keep\` to keep it.`);
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
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.restartLabel]
 * @param {(answers: Record<string, string>) => Promise<string | void> | string | void} opts.onComplete
 * @param {(reason: 'cancel' | 'timeout') => any} [opts.onCancel]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'busy' | 'dm_closed' | 'no_questions' }>}
 */
export async function startQuestionnaire({
  user,
  platform = 'discord',
  questions,
  prefill = {},
  header = '',
  review = null,
  confirmLabel = 'Post',
  restartLabel = 'Start over',
  onComplete,
  onCancel = null,
  timeoutMs = SESSION_TIMEOUT_MS,
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
    confirmLabel,
    restartLabel,
    onComplete,
    onCancel,
    timeoutMs,
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

  const q = session.questions[session.index];
  if (word === 'skip') {
    if (q.required) {
      await reply(session, 'That question is required, so it cannot be skipped.');
      return;
    }
    session.answers[q.id] = '';
    await advance(session);
    return;
  }
  if (word === 'keep' && session.prefill[q.id]) {
    session.answers[q.id] = session.prefill[q.id];
    await advance(session);
    return;
  }
  if (!text) {
    await reply(session, 'Please answer with text.');
    return;
  }
  const limit = cap(q.maxLength, 1024);
  if (text.length > limit) {
    await reply(
      session,
      `That is ${text.length} characters, and the limit is ${limit}. Shorten it and send it again.`
    );
    return;
  }
  session.answers[q.id] = text;
  await advance(session);
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
  session.state = 'review';
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
}

/** Run onComplete and tell the member the result. `editable` is the preview message, when there is one. */
async function complete(session, editable) {
  session.state = 'done';
  endSession(session);
  const say = (content) =>
    editable ? editable.edit({ content, embeds: [], components: [] }) : deliver(session, { content });
  try {
    const result = await session.onComplete({ ...session.answers });
    await say(typeof result === 'string' && result ? result : 'Done.');
  } catch (err) {
    log.error('questionnaire', 'onComplete failed:', err.message);
    await say('Something went wrong, so nothing was changed. Please try again in a moment.').catch(() => {});
  }
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
    await interaction.update({ content: 'Starting over.', embeds: [], components: [] });
    await deliver(session, { content: promptFor(session) });
    return;
  }

  if (action === 'ok') {
    session.state = 'done'; // a second press while this one runs finds no review
    await interaction.update({ content: 'Working on it…', embeds: [], components: [] });
    await complete(session, interaction.message);
  }
}

registerComponent('questionnaire', PREFIX, handleButton);
