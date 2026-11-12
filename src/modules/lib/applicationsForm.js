// Applications, the pure half: the settings of a form and their normaliser, reading and checking an
// answer (the same code for the DM questionnaire and the web form, so the two can never disagree),
// the requirements a member must meet, the texts with their placeholders, the post of a submission as
// embeds that stay inside Discord's limits, and the export. Nothing here talks to a platform or to the
// database: everything comes in as arguments.
//
// Answers are stored as text, one entry per question id:
//   text    the cleaned text
//   choice  the chosen option ids in the order of the options, joined by ","
//   role    the chosen role ids (the options are roles), in the order of the options, joined by ","
//   yesno   "yes" or "no"
//   (an optional question left empty: "")
import { randomBytes } from 'node:crypto';
import { cleanAnswer, cut, escapeMarkdown } from '../introductions.js';
import { idList } from '../../web/lib/idList.js';

export const MAX_FORMS = 10;
export const SHORT_TEXT_MAX = 1024;
export const LONG_TEXT_MAX = 4000;
export const MAX_OPTIONS = 10;
export const FILL_MODES = ['discord', 'web', 'both'];
export const QUESTION_TYPES = ['text', 'choice', 'role', 'yesno'];
export const GRANT_WHEN = ['never', 'submit', 'accept'];
export const DEFAULT_RETENTION_DAYS = 180;
export const DEFAULT_TIMEOUT_MINUTES = 30;

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  name: { maxLength: 60 },
  description: { maxLength: 500 },
  timeoutMinutes: { min: 1, max: 1440 },
  questions: { maxItems: 25 },
  'questions[].label': { maxLength: 100 },
  'questions[].help': { maxLength: 300 },
  'questions[].minLength': { min: 0, max: LONG_TEXT_MAX },
  'questions[].maxLength': { min: 1, max: LONG_TEXT_MAX },
  'questions[].options': { maxItems: MAX_OPTIONS },
  'questions[].options[].label': { maxLength: 80 },
  minAccountDays: { min: 0, max: 3650 },
  minServerDays: { min: 0, max: 3650 },
  cooldownHours: { min: 0, max: 8760 },
  requiredRoleIds: { maxItems: 25 },
  restrictedRoleIds: { maxItems: 25 },
  managerRoleIds: { maxItems: 25 },
  pingRoleIds: { maxItems: 10 },
  removeOnSubmitRoleIds: { maxItems: 25 },
  acceptAddRoleIds: { maxItems: 25 },
  acceptRemoveRoleIds: { maxItems: 25 },
  denyAddRoleIds: { maxItems: 25 },
  denyRemoveRoleIds: { maxItems: 25 },
  'messages.start': { maxLength: 1000 },
  'messages.completed': { maxLength: 1000 },
  'messages.accepted': { maxLength: 1000 },
  'messages.denied': { maxLength: 1000 },
  retentionDays: { min: 7, max: 3650 },
  panelText: { maxLength: 500 },
};

export const PLACEHOLDERS = ['{user}', '{server}', '{form}', '{reason}'];

export const DEFAULT_MESSAGES = Object.freeze({
  start: 'Applying for **{form}** in **{server}**. Answer the questions below one at a time.',
  completed:
    'Thanks {user}! Your application for **{form}** in **{server}** was submitted. Staff will look at it soon.',
  accepted: 'Good news {user}: your application for **{form}** in **{server}** was accepted. {reason}',
  denied: 'Your application for **{form}** in **{server}** was not accepted this time. {reason}',
});

// --- normalising settings ---------------------------------------------------------------------------

/** Cut to `max` UTF-16 units without half an emoji at the end (a limit is a limit, not a hint). */
const clip = (value, max) => {
  const out = String(value ?? '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};
const snowflake = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const clampInt = (value, { min, max }, fallback) => {
  const n = Math.round(Number(value));
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const newId = (prefix) => `${prefix}${randomBytes(3).toString('hex')}`;
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v);

/** Options of a choice or role question: unique ids, at most MAX_OPTIONS. */
function normaliseOptions(raw, type) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS['questions[].options'].maxItems) break;
    const label = clip(String(item?.label ?? '').trim(), LIMITS['questions[].options[].label'].maxLength);
    let id = item?.id;
    if (type === 'role') {
      // A role option is the role itself.
      id = snowflake(id);
      if (!id || seen.has(id)) continue;
    } else {
      if (!label) continue;
      if (!validId(id) || seen.has(id)) id = newId('o');
    }
    seen.add(id);
    out.push({ id, label });
  }
  return out;
}

function normaliseQuestion(item, seenIds) {
  const type = oneOf(item?.type, QUESTION_TYPES, 'text');
  const label = clip(String(item?.label ?? '').trim(), LIMITS['questions[].label'].maxLength);
  if (!label) return null;
  let id = validId(item?.id) ? item.id : '';
  if (!id || seenIds.has(id)) id = newId('q');
  seenIds.add(id);
  const long = item?.long === true;
  const cap = long ? LONG_TEXT_MAX : SHORT_TEXT_MAX;
  const minLength = clampInt(item?.minLength, { min: LIMITS['questions[].minLength'].min, max: cap }, 0);
  // A longest answer shorter than the shortest one is raised to it.
  const maxLength = Math.max(
    minLength,
    clampInt(item?.maxLength, { min: LIMITS['questions[].maxLength'].min, max: cap }, long ? 1500 : 300)
  );
  const options = normaliseOptions(item?.options, type);
  const multiple = item?.multiple === true;
  // A required choice or role question with no options could never be answered. Saving one is refused
  // (formProblems reads `unanswerable`); one that is stored already counts as optional, so members are
  // not stuck at it.
  const unanswerable =
    item?.required === true && (type === 'choice' || type === 'role') && options.length === 0;
  const required = item?.required === true && !unanswerable;
  const count = options.length;
  const maxChoices = multiple
    ? Math.min(count, Math.max(1, clampInt(item?.maxChoices, { min: 1, max: MAX_OPTIONS }, count || 1)))
    : 1;
  const minChoices = multiple
    ? Math.min(maxChoices, clampInt(item?.minChoices, { min: 0, max: MAX_OPTIONS }, 0))
    : 0;
  return {
    id,
    type,
    label,
    help: clip(String(item?.help ?? '').trim(), LIMITS['questions[].help'].maxLength),
    required,
    unanswerable,
    long,
    minLength,
    maxLength,
    options,
    multiple,
    minChoices,
    maxChoices,
    grant: oneOf(item?.grant, GRANT_WHEN, 'never'),
  };
}

/** The questions of a form: at most 25, each with a stable id. */
export function normaliseQuestions(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS.questions.maxItems) break;
    const q = normaliseQuestion(item, seen);
    if (q) out.push(q);
  }
  return out;
}

const ids = (raw, key) => idList(raw?.[key], LIMITS[key].maxItems);
const days = (raw, key) => clampInt(raw?.[key], LIMITS[key], 0);

/**
 * Coerce a form (a request body or a stored config) into the canonical shape. Anything missing gets
 * its default, so a stored form from an older version still reads.
 */
export function normaliseForm(raw = {}) {
  const m = raw?.messages && typeof raw.messages === 'object' ? raw.messages : {};
  const message = (key) =>
    typeof m[key] === 'string'
      ? clip(m[key].trim(), LIMITS[`messages.${key}`].maxLength)
      : DEFAULT_MESSAGES[key];
  return {
    name: clip(String(raw?.name ?? '').trim(), LIMITS.name.maxLength),
    description: clip(String(raw?.description ?? '').trim(), LIMITS.description.maxLength),
    enabled: raw?.enabled === true || raw?.enabled === 1,
    fillMode: oneOf(raw?.fillMode, FILL_MODES, 'both'),
    timeoutMinutes: clampInt(raw?.timeoutMinutes, LIMITS.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES),
    questions: normaliseQuestions(raw?.questions),
    requiredRoleIds: ids(raw, 'requiredRoleIds'),
    requiredRolesMode: oneOf(raw?.requiredRolesMode, ['all', 'any'], 'all'),
    restrictedRoleIds: ids(raw, 'restrictedRoleIds'),
    restrictedRolesMode: oneOf(raw?.restrictedRolesMode, ['any', 'all'], 'any'),
    minAccountDays: days(raw, 'minAccountDays'),
    minServerDays: days(raw, 'minServerDays'),
    cooldownHours: days(raw, 'cooldownHours'),
    pendingChannelId: snowflake(raw?.pendingChannelId),
    acceptedChannelId: snowflake(raw?.acceptedChannelId),
    deniedChannelId: snowflake(raw?.deniedChannelId),
    decidedPost: oneOf(raw?.decidedPost, ['move', 'copy'], 'move'),
    pingRoleIds: ids(raw, 'pingRoleIds'),
    managerRoleIds: ids(raw, 'managerRoleIds'),
    staffThread: raw?.staffThread === true,
    pendingRoleId: snowflake(raw?.pendingRoleId),
    removeOnSubmitRoleIds: ids(raw, 'removeOnSubmitRoleIds'),
    acceptAddRoleIds: ids(raw, 'acceptAddRoleIds'),
    acceptRemoveRoleIds: ids(raw, 'acceptRemoveRoleIds'),
    denyAddRoleIds: ids(raw, 'denyAddRoleIds'),
    denyRemoveRoleIds: ids(raw, 'denyRemoveRoleIds'),
    onLeave: oneOf(raw?.onLeave, ['keep', 'deny'], 'keep'),
    messages: {
      start: message('start'),
      completed: message('completed'),
      accepted: message('accepted'),
      denied: message('denied'),
    },
  };
}

/** The settings that belong to the module as a whole (not to one form). */
export function normaliseApplicationsConfig(raw = {}) {
  return {
    retentionDays: clampInt(raw?.retentionDays, LIMITS.retentionDays, DEFAULT_RETENTION_DAYS),
    panelChannelId: snowflake(raw?.panelChannelId),
    panelMessageId: snowflake(raw?.panelMessageId),
    panelText: clip(String(raw?.panelText ?? '').trim(), LIMITS.panelText.maxLength),
  };
}

/** Why a form cannot take applications yet (what staff still have to set), or null. */
export function formSetupProblem(form) {
  if (!form.questions.length) return 'The form has no questions.';
  if (!form.pendingChannelId) return 'No channel is set for new applications.';
  return null;
}

/** Every role a form may add or remove, for the up-front check of what Sylo can manage. */
export function rolesOfForm(form) {
  const all = new Set([
    form.pendingRoleId,
    ...form.removeOnSubmitRoleIds,
    ...form.acceptAddRoleIds,
    ...form.acceptRemoveRoleIds,
    ...form.denyAddRoleIds,
    ...form.denyRemoveRoleIds,
  ]);
  for (const q of form.questions) {
    if (q.type === 'role' && q.grant !== 'never') for (const o of q.options) all.add(o.id);
  }
  all.delete('');
  all.delete(undefined);
  return [...all];
}

// --- reading and checking an answer ----------------------------------------------------------------

const YES = new Set(['yes', 'y', 'true', '1', 'ja']);
const NO = new Set(['no', 'n', 'false', '0', 'nei']);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The stored ids of a choice/role answer as a list. */
export const idsOfAnswer = (stored) =>
  String(stored ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Turn what a member gave (a string, or a list of option ids from the web form) into the stored
 * answer of question `q`, or say why not. An empty answer is allowed here and gives "" (whether an
 * empty answer is allowed is `answerProblem`'s job).
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function canonicalise(q, input) {
  if (q.type === 'text') {
    if (input !== undefined && input !== null && typeof input !== 'string') {
      return { ok: false, error: 'Write the answer as text.' };
    }
    const value = cleanAnswer(input ?? '');
    if (!value) return { ok: true, value: '' };
    if (value.length > q.maxLength) {
      return { ok: false, error: `That is ${value.length} characters, and the limit is ${q.maxLength}.` };
    }
    if (value.length < q.minLength) {
      return {
        ok: false,
        error: `That is ${value.length} characters, and at least ${q.minLength} are needed.`,
      };
    }
    return { ok: true, value };
  }
  if (q.type === 'yesno') {
    if (input === true) return { ok: true, value: 'yes' };
    if (input === false) return { ok: true, value: 'no' };
    const word = String(input ?? '')
      .trim()
      .toLowerCase();
    if (!word) return { ok: true, value: '' };
    if (YES.has(word)) return { ok: true, value: 'yes' };
    if (NO.has(word)) return { ok: true, value: 'no' };
    return { ok: false, error: 'Answer yes or no.' };
  }
  // choice and role
  const raw = Array.isArray(input) ? input : idsOfAnswer(input);
  if (raw.some((v) => typeof v !== 'string')) return { ok: false, error: 'That is not a valid choice.' };
  const wanted = new Set(raw.map((v) => v.trim()).filter(Boolean));
  const known = new Set(q.options.map((o) => o.id));
  for (const id of wanted) {
    if (!known.has(id)) return { ok: false, error: 'That is not one of the options.' };
  }
  // In the order of the options, so the same choice is always stored the same way.
  const chosen = q.options.map((o) => o.id).filter((id) => wanted.has(id));
  if (chosen.length === 0) return { ok: true, value: '' };
  if (!q.multiple && chosen.length > 1) return { ok: false, error: 'Choose only one option.' };
  if (q.multiple) {
    if (chosen.length > q.maxChoices) {
      return { ok: false, error: `Choose at most ${plural(q.maxChoices, 'option', 'options')}.` };
    }
    if (chosen.length < q.minChoices) {
      return { ok: false, error: `Choose at least ${plural(q.minChoices, 'option', 'options')}.` };
    }
  }
  return { ok: true, value: chosen.join(',') };
}

/** Is an already canonical value fine for this question (also on its own: required, minimum)? */
export function answerProblem(q, value) {
  const text = String(value ?? '');
  if (!text) return q.required ? 'This question is required.' : null;
  const again = canonicalise(q, q.type === 'text' || q.type === 'yesno' ? text : idsOfAnswer(text));
  if (!again.ok) return again.error;
  if (again.value !== text) return 'That answer is not valid.';
  return null;
}

/**
 * Check a whole set of answers (a web form, or the answers of a finished DM session). Only the asked
 * questions count; extra keys are ignored.
 * @param {ReturnType<typeof normaliseQuestions>} questions
 * @param {Record<string, unknown>} raw  question id -> what the member gave
 * @returns {{ ok: true, answers: Record<string, string> } | { ok: false, errors: Record<string, string> }}
 */
export function validateAnswers(questions, raw) {
  const answers = {};
  const errors = {};
  const given = raw && typeof raw === 'object' ? raw : {};
  for (const q of questions) {
    const read = canonicalise(q, given[q.id]);
    if (!read.ok) {
      errors[q.id] = read.error;
      continue;
    }
    const problem = answerProblem(q, read.value);
    if (problem) errors[q.id] = problem;
    else answers[q.id] = read.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers };
}

/** A stored answer in words (option labels for choices), plain text. */
export function displayAnswer(q, stored) {
  const text = String(stored ?? '');
  if (!text) return '';
  if (q.type === 'yesno') return text === 'yes' ? 'Yes' : text === 'no' ? 'No' : text;
  if (q.type === 'choice' || q.type === 'role') {
    return idsOfAnswer(text)
      .map((id) => q.options.find((o) => o.id === id)?.label || (q.type === 'role' ? 'a role' : id))
      .join(', ');
  }
  return text;
}

// --- the DM side ---------------------------------------------------------------------------------------

/** "1, 3" or "1 3" -> option ids, or an error. */
function idsFromNumbers(q, text) {
  const t = String(text).trim();
  if (!/^\d+(?:\s*[,\s]\s*\d+)*$/.test(t)) {
    return { error: 'Answer with the numbers of the options, for example 2 or 1,3.' };
  }
  const picked = [];
  for (const n of t.match(/\d+/g).map(Number)) {
    if (n < 1 || n > q.options.length)
      return { error: `There is no option ${n}. Pick from 1 to ${q.options.length}.` };
    picked.push(q.options[n - 1].id);
  }
  return { ids: picked };
}

const hintFor = (q) => {
  if (q.type === 'yesno') return 'Answer **yes** or **no**.';
  if (q.type === 'text') {
    return q.minLength > 0
      ? `Between ${q.minLength} and ${q.maxLength} characters.`
      : `Up to ${q.maxLength} characters.`;
  }
  if (!q.multiple) return 'Answer with the number of one option.';
  const count = `${q.minChoices > 0 ? `${q.minChoices} to ` : 'up to '}${q.maxChoices}`;
  return `Answer with the numbers of your choices (${count}), for example 1,3.`;
};

/**
 * A question as the DM questionnaire engine wants it (bot/lib/dmQuestionnaire.js). Choices and roles
 * are asked as numbered options and answered with the numbers; everything is read and checked by
 * canonicalise() and answerProblem(), the same as the web form.
 */
export function dmQuestionOf(q) {
  const lines = [];
  if (q.help) lines.push(q.help);
  if (q.type === 'choice' || q.type === 'role') {
    lines.push(...q.options.map((o, i) => `**${i + 1}.** ${escapeMarkdown(o.label || 'a role')}`));
  }
  return {
    id: q.id,
    label: q.label,
    prompt: lines.join('\n'),
    required: q.required,
    maxLength: q.type === 'text' ? q.maxLength : undefined,
    exact: q.type !== 'text',
    hint: hintFor(q),
    normalise: (text) => {
      const input =
        q.type === 'choice' || q.type === 'role'
          ? (() => {
              const picked = idsFromNumbers(q, text);
              return picked.error ? picked : picked.ids;
            })()
          : text;
      if (input?.error) return { error: input.error };
      const read = canonicalise(q, input);
      return read.ok ? read.value : { error: read.error };
    },
    validate: (value) => answerProblem(q, value),
    show: (value) => displayAnswer(q, value),
  };
}

// --- texts ----------------------------------------------------------------------------------------------

/**
 * Fill {user}, {server}, {form} and {reason} in one pass, so a value (a form called "{reason}") is
 * never expanded again.
 */
export function fillTemplate(template, values) {
  return String(template ?? '')
    .replace(/\{(user|server|form|reason)\}/gi, (_, key) => String(values?.[key.toLowerCase()] ?? ''))
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// --- requirements ----------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** "3 days", "5 hours" ... for a refusal text. */
export function humanDuration(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return plural(minutes, 'minute', 'minutes');
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return plural(hours, 'hour', 'hours');
  return plural(Math.ceil(hours / 24), 'day', 'days');
}

/**
 * The first requirement a member does not meet, or null. Run when they start and again when they
 * submit. `facts` are what the caller looked up:
 * `{ roleIds, accountCreatedAt, joinedAt, pending, cooldownUntil, now }`; a time that is unknown
 * (null) fails the check that needs it, so a platform that cannot tell never lets someone through.
 * @returns {{ reason: string, text: string } | null}
 */
export function checkRequirements(form, facts) {
  const now = facts.now ?? Date.now();
  const has = new Set(facts.roleIds ?? []);
  const refuse = (reason, text) => ({ reason, text });

  if (form.requiredRoleIds.length) {
    const met =
      form.requiredRolesMode === 'any'
        ? form.requiredRoleIds.some((id) => has.has(id))
        : form.requiredRoleIds.every((id) => has.has(id));
    if (!met) {
      return refuse(
        'missing_roles',
        form.requiredRolesMode === 'any'
          ? 'You need at least one of the required roles to apply.'
          : 'You need all of the required roles to apply.'
      );
    }
  }
  if (form.restrictedRoleIds.length) {
    const blocked =
      form.restrictedRolesMode === 'all'
        ? form.restrictedRoleIds.every((id) => has.has(id))
        : form.restrictedRoleIds.some((id) => has.has(id));
    if (blocked) return refuse('restricted_role', 'You have a role that cannot apply for this form.');
  }
  if (form.minAccountDays > 0) {
    const need = form.minAccountDays * DAY_MS;
    if (!facts.accountCreatedAt || now - facts.accountCreatedAt < need) {
      return refuse(
        'account_age',
        `Your account must be at least ${plural(form.minAccountDays, 'day', 'days')} old.`
      );
    }
  }
  if (form.minServerDays > 0) {
    const need = form.minServerDays * DAY_MS;
    if (!facts.joinedAt || now - facts.joinedAt < need) {
      return refuse(
        'server_time',
        `You must have been in this server for at least ${plural(form.minServerDays, 'day', 'days')}.`
      );
    }
  }
  if (facts.cooldownUntil && facts.cooldownUntil > now) {
    return refuse(
      'cooldown',
      `Your last application was denied. You can apply again in ${humanDuration(facts.cooldownUntil - now)}.`
    );
  }
  if (facts.pending) {
    return refuse('pending', 'You already have an application for this form waiting for a decision.');
  }
  return null;
}

// --- the post ----------------------------------------------------------------------------------------------

export const STATUS_META = {
  pending: { label: 'Pending', emoji: '⏳', color: 0x5865f2 },
  accepted: { label: 'Accepted', emoji: '✅', color: 0x57f287 },
  denied: { label: 'Denied', emoji: '❌', color: 0xed4245 },
  withdrawn: { label: 'Withdrawn', emoji: '↩️', color: 0x95a5a6 },
};

// Discord: 6000 characters over all the embeds of a message, 25 fields and 1024 characters a field.
const TOTAL_BUDGET = 5800;
const FIELDS_PER_EMBED = 25;
const FIELD_VALUE_MAX = 1024;
const EMBEDS_MAX = 10;

/** Split text into pieces of at most `max` characters, at a line break or a space where possible. */
export function chunkText(text, max = FIELD_VALUE_MAX) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max);
    if (at < max / 2) at = rest.lastIndexOf(' ', max);
    if (at < max / 2) at = max;
    // never inside a surrogate pair or after an odd backslash
    let piece = rest.slice(0, at);
    if (/[\uD800-\uDBFF]$/.test(piece)) piece = piece.slice(0, -1);
    const trailing = /\\+$/.exec(piece)?.[0].length ?? 0;
    if (trailing % 2 === 1) piece = piece.slice(0, -1);
    out.push(piece);
    rest = rest.slice(piece.length).replace(/^[ \n]/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The embeds of a submission: a header with the applicant, status and decision, then every answer
 * (long ones split over several fields, and over more embeds when one is full). Everything stays
 * inside Discord's limits; when the answers do not fit, the last field says how many are left out.
 * Pure: names come in as arguments.
 * @param {{ submission: ReturnType<import('../../db/applications.js').submissionOf>, applicant: string,
 *   decidedBy?: string, warning?: string, preview?: boolean }} args
 *   `preview`: the member's own look at the answers before they submit (no status, no number).
 *   `applicant` is how to show the member (a mention); `decidedBy` the same for the reviewer.
 * @returns {Array<{ title?: string, description?: string, color: number, fields: Array<{name: string, value: string, inline?: boolean}>, footer?: {text: string}, timestamp?: string }>}
 */
export function buildSubmissionEmbeds({
  submission: sub,
  applicant,
  decidedBy = '',
  warning = '',
  preview = false,
}) {
  const meta = STATUS_META[sub.status] ?? STATUS_META.pending;
  const header = preview
    ? [`**Applicant:** ${applicant}`, 'This is how staff will see your answers.']
    : [
        `**Applicant:** ${applicant}`,
        `**Status:** ${meta.emoji} ${meta.label}${decidedBy && sub.status !== 'pending' ? ` by ${decidedBy}` : ''}`,
        `**Sent:** ${sub.source === 'web' ? 'on the web' : 'in DM'} · <t:${Math.floor(sub.createdAt / 1000)}:R>`,
      ];
  if (sub.reason) header.push(`**Reason:** ${cut(escapeMarkdown(sub.reason), 900)}`);
  if (warning) header.push(`⚠️ ${cut(warning, 400)}`);
  if (sub.dmNote) header.push(`✉️ Could not send the applicant a DM (${sub.dmNote}).`);

  const first = {
    title: cut(
      preview
        ? escapeMarkdown(sub.formName || 'Application')
        : `${escapeMarkdown(sub.formName || 'Application')} · #${sub.id}`,
      256
    ),
    description: header.join('\n'),
    color: meta.color,
    fields: [],
  };
  const embeds = [first];
  let total = first.title.length + first.description.length + 40;
  let left = 0;

  const questions = sub.questions ?? [];
  let truncated = false;
  for (const q of questions) {
    if (truncated) {
      left += 1;
      continue;
    }
    const shown = escapeMarkdown(displayAnswer(q, sub.answers?.[q.id]));
    const pieces = chunkText(shown || '—');
    const name = escapeMarkdown(q.label);
    for (let i = 0; i < pieces.length; i += 1) {
      const field = { name: cut(i === 0 ? name : `${name} (cont.)`, 256), value: pieces[i] };
      const cost = field.name.length + field.value.length;
      let target = embeds.at(-1);
      if (target.fields.length >= FIELDS_PER_EMBED) {
        if (embeds.length >= EMBEDS_MAX) {
          truncated = true;
          break;
        }
        target = { color: meta.color, fields: [] };
        embeds.push(target);
      }
      if (total + cost > TOTAL_BUDGET) {
        truncated = true;
        break;
      }
      target.fields.push(field);
      total += cost;
    }
    if (truncated) left += 1;
  }
  if (truncated) {
    const note = `The rest is on the dashboard (${plural(left, 'answer', 'answers')} cut short).`;
    const target = embeds.at(-1);
    if (target.fields.length < FIELDS_PER_EMBED) target.fields.push({ name: '…', value: note });
    else target.footer = { text: note };
  }
  embeds.at(-1).footer ??= { text: preview ? 'Not sent yet' : `Application #${sub.id}` };
  return embeds;
}

// --- the export ----------------------------------------------------------------------------------------------

/**
 * A cell as CSV. Every cell is quoted, so a "," or a ";" (the separator of Excel in many countries) inside
 * an answer can never split it into cells of its own. A cell that a spreadsheet would run as a formula (it
 * starts with = + - @, a tab or a line break, also after leading spaces or separators) is made text with a
 * leading '.
 */
export const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[ ;,]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/** The columns of an export: every question that appears in any of the snapshots, in order. */
function exportColumns(submissions) {
  const columns = new Map();
  for (const sub of submissions) {
    for (const q of sub.questions ?? []) columns.set(q.id, q);
  }
  return [...columns.values()];
}

/**
 * Answers only: the submission, who sent it, its status and date, and the answers (no reviewer, reason
 * or history). A cell reads the way the member saw it (option labels, not ids).
 */
export function exportRows(submissions) {
  const columns = exportColumns(submissions);
  const rows = submissions.map((sub) => {
    const byId = new Map((sub.questions ?? []).map((q) => [q.id, q]));
    return {
      id: sub.id,
      applicantId: sub.userId,
      status: sub.status,
      submittedAt: new Date(sub.createdAt).toISOString(),
      answers: columns.map((q) => (byId.has(q.id) ? displayAnswer(byId.get(q.id), sub.answers?.[q.id]) : '')),
    };
  });
  return { columns, rows };
}

export function exportCsv(submissions) {
  const { columns, rows } = exportRows(submissions);
  const head = ['Submission', 'Applicant', 'Status', 'Submitted', ...columns.map((q) => q.label)];
  const lines = [head, ...rows.map((r) => [r.id, r.applicantId, r.status, r.submittedAt, ...r.answers])];
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function exportJson(submissions) {
  const { columns, rows } = exportRows(submissions);
  return JSON.stringify(
    rows.map((r) => ({
      submission: r.id,
      applicant: r.applicantId,
      status: r.status,
      submitted: r.submittedAt,
      answers: columns.map((q, i) => ({ question: q.label, type: q.type, answer: r.answers[i] })),
    })),
    null,
    2
  );
}
