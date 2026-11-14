// Applications: forms members fill in (in DM, on the web, or both) and staff accept or deny.
//
// A server has up to 10 forms. A member starts one with /apply, or with a button on the panel message
// staff publish in a channel. The answers are checked by the same code whether they come from the DM
// questionnaire (bot/lib/dmQuestionnaire.js) or from the web form (web/routes/v2Apply.js): see
// modules/lib/applicationsForm.js. A submission is stored (db/applications.js), posted as an embed in the
// form's channel with Accept and Deny buttons, and decided once:
//
//   - the decision is one conditional UPDATE (a pending row becomes accepted or denied), so a double
//     click, or two staff at the same moment, decide it only once. Everything after it (roles, the post,
//     the message to the applicant) is best effort and never takes the decision back; a role change
//     that fails is kept on the row and can be retried from the dashboard.
//   - who may decide: the form's manager roles, or Manage Server. Every path (button, command,
//     dashboard, leaving the server) goes through decideSubmission().
//
// Answers are personal data: they are never logged, `/forget` deletes them and their posts, and
// decided submissions are deleted after a number of days (see sweepApplications).
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { on } from './dispatch.js';
import { every } from './schedule.js';
import { config as appConfig } from '../config.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import {
  allSubmissionsOfUser,
  claimDecision,
  clearSubmissionAnswers,
  clearedSubmissions,
  decidedBeforeInGuild,
  deleteSubmission,
  getCooldownUntil,
  getForm as getFormRow,
  getSubmission,
  getSubmissionAny,
  guildsWithDecidedBefore,
  insertSubmission,
  isUniqueViolation,
  listForms as listFormRows,
  pendingOfUser,
  pendingSubmission,
  pruneCooldowns,
  clearSubmissionCopy,
  clearSubmissionPost,
  setSubmissionCopy,
  setSubmissionDmNote,
  setSubmissionPost,
  setSubmissionRoles,
  setSubmissionThread,
  submissionByMessage,
  touchSubmission,
} from '../db/applications.js';
import {
  clientOfGuild,
  guildByKey,
  guildKey,
  guildSupports,
  platformOfGuild,
  rawGuildId,
} from '../platform/platformOf.js';
import {
  cancelQuestionnaire,
  cancelQuestionnairesOf,
  startQuestionnaire,
} from '../bot/lib/dmQuestionnaire.js';
import { registerComponent } from '../bot/lib/components.js';
import { isMessageGone, isNotFound, isPermissionDenied } from '../platform/messageErrors.js';
import { sweepMap } from '../lib/sweepMap.js';
import { log } from '../lib/log.js';
import { botRefusal } from './tempRoles.js';
import { cleanAnswer, cut } from './introductions.js';
import {
  DEFAULT_RETENTION_DAYS,
  FILL_MODES,
  LIMITS,
  MAX_FORMS,
  PLACEHOLDERS,
  buildSubmissionEmbeds,
  checkRequirements,
  displayAnswer,
  dmQuestionOf,
  fillTemplate,
  formSetupProblem,
  idsOfAnswer,
  normaliseApplicationsConfig,
  normaliseForm,
  rolesOfForm,
  validateAnswers,
} from './lib/applicationsForm.js';

export {
  DEFAULT_RETENTION_DAYS,
  FILL_MODES,
  LIMITS,
  MAX_FORMS,
  PLACEHOLDERS,
  normaliseApplicationsConfig,
  normaliseForm,
  rolesOfForm,
};

const DAY_MS = 86_400_000;
const NO_MENTIONS = { parse: [] };
// A session carries the server and the form it belongs to, so one form can be ended without the others.
const sessionScope = (key, formId) => `applications:${key}:${formId}`;
const serverScope = (key) => `applications:${key}:`;

/** End every running application questionnaire of a server (the module was switched off there). */
export function cancelApplicationSessions(key) {
  return cancelQuestionnairesOf(serverScope(key), 'module off', { prefix: true });
}

/** End the running questionnaires of one form (it was closed or deleted), and only those. */
export function cancelFormSessions(key, formId) {
  return cancelQuestionnairesOf(sessionScope(key, formId), 'form closed');
}

// --- forms and settings -----------------------------------------------------------------------------------

/** A stored form row as one object: the columns win over the copy inside the config. */
export function hydrateForm(row) {
  if (!row) return null;
  return {
    ...normaliseForm(row.config),
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    enabled: row.enabled,
    fillMode: row.fillMode,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadForm(key, id) {
  return hydrateForm(await getFormRow(key, id));
}
export async function loadForms(key) {
  return (await listFormRows(key)).map(hydrateForm);
}
/**
 * How far back a question of a questionnaire still counts as "the one this answer is for" (the DM handler
 * uses it after a restart): the longest form timeout among the servers the member is in, at most 24 hours,
 * and at least `base`.
 */
export async function lateAnswerWindowMs(client, userId, base) {
  let longest = base;
  for (const guild of client?.guilds?.cache?.values?.() ?? []) {
    if (!guild.members?.cache?.has?.(userId)) continue;
    for (const row of await listFormRows(guildKey(guild))) {
      longest = Math.max(longest, hydrateForm(row).timeoutMinutes * 60_000);
    }
  }
  return Math.min(longest, 24 * 3_600_000);
}

export async function applicationsConfig(key) {
  return normaliseApplicationsConfig((await getGuildModule(key, 'applications')).config);
}

/** The questions with the current role names filled into role options (a snapshot "as asked"). */
export function withRoleNames(questions, guild) {
  return questions.map((q) =>
    q.type === 'role'
      ? {
          ...q,
          options: q.options.map((o) => ({
            ...o,
            label: cut(
              guild?.roles?.cache?.get?.(o.id)?.name ?? o.label ?? '',
              LIMITS['questions[].options[].label'].maxLength
            ),
          })),
        }
      : q
  );
}

// --- members and permissions ---------------------------------------------------------------------------

async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

const timeOf = (...values) => {
  for (const v of values) {
    if (typeof v === 'number' && v > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getTime();
  }
  return null;
};

/** What the requirements look at about a member (a time the platform does not tell is null). */
export const factsOfMember = (member) => ({
  roleIds: [...(member?.roles?.cache?.keys?.() ?? [])],
  accountCreatedAt: timeOf(member?.user?.createdTimestamp, member?.user?.createdAt),
  joinedAt: timeOf(member?.joinedTimestamp, member?.joinedAt),
});

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false;
  }
};

/**
 * Who may decide on this form's submissions: Manage Server or Administrator, or one of the form's
 * manager roles.
 * @param {{ managerRoleIds?: string[] } | null} form
 */
export function canManageApplications(member, permissions, form) {
  if (['ManageGuild', 'Administrator'].some((p) => hasPermission(permissions, p))) return true;
  const roles = Array.isArray(form?.managerRoleIds) ? form.managerRoleIds : [];
  return roles.some((id) => member?.roles?.cache?.has?.(id));
}

// --- roles ----------------------------------------------------------------------------------------------

/**
 * Whether Sylo can manage every role the form may add or remove (Manage Roles, and a role below its
 * own highest one). Checked before a member starts and again when they submit, so a form that Sylo
 * could not finish is refused up front instead of half done.
 * @returns {string | null} a reason, or null
 */
export function roleSetupProblem(guild, form) {
  const everyone = rawGuildId(guild);
  for (const id of rolesOfForm(form)) {
    if (id === everyone) return "@everyone can't be given or taken away.";
    const role = guild.roles?.cache?.get?.(id);
    const why = botRefusal(guild, role);
    if (why) return `${role?.name ? `${role.name}: ` : ''}${why}`;
  }
  return null;
}

/** The role changes a form makes at one point; a later entry for the same role wins. */
function mergeOps(...lists) {
  const byRole = new Map();
  for (const list of lists) for (const op of list ?? []) byRole.set(op.roleId, op);
  // removals first, then additions
  return [...byRole.values()].sort((a, b) => (a.op === b.op ? 0 : a.op === 'remove' ? -1 : 1));
}
const addOps = (roleIds) => roleIds.filter(Boolean).map((roleId) => ({ op: 'add', roleId }));
const removeOps = (roleIds) => roleIds.filter(Boolean).map((roleId) => ({ op: 'remove', roleId }));

/**
 * The roles a role question's answer gives, when `grant` says now. The answer was given to the
 * questions as they were asked (the snapshot), but what a role question may give is the form as it is
 * now: a role that staff took out of the question, or a question they set to give nothing, is not given
 * (and is reported in `skipped`), also for an application made before that change. A form that no longer
 * exists gives nothing.
 * @returns {{ ids: string[], skipped: string[] }}
 */
function questionGrants(form, questions, answers, when) {
  const ids = [];
  const skipped = [];
  for (const q of questions ?? []) {
    if (q.type !== 'role' || q.grant !== when) continue;
    const current = form?.questions?.find((x) => x.id === q.id);
    const allowed = new Set(
      current?.type === 'role' && current.grant === when ? current.options.map((o) => o.id) : []
    );
    for (const id of idsOfAnswer(answers?.[q.id])) {
      if (!q.options.some((o) => o.id === id)) continue;
      (allowed.has(id) ? ids : skipped).push(id);
    }
  }
  return { ids, skipped };
}

function submitOps(form, sub) {
  return mergeOps(
    addOps([form.pendingRoleId]),
    removeOps(form.removeOnSubmitRoleIds),
    addOps(questionGrants(form, sub.questions, sub.answers, 'submit').ids)
  );
}

/** What a decision changes in roles. `grants` are the role question's roles that may still be given. */
function decisionOps(form, status, grants = []) {
  if (status === 'accepted') {
    return mergeOps(
      removeOps([form.pendingRoleId]),
      removeOps(form.acceptRemoveRoleIds),
      addOps(form.acceptAddRoleIds),
      addOps(grants)
    );
  }
  if (status === 'denied') {
    return mergeOps(
      removeOps([form.pendingRoleId]),
      removeOps(form.denyRemoveRoleIds),
      addOps(form.denyAddRoleIds)
    );
  }
  return mergeOps(removeOps([form.pendingRoleId])); // withdrawn
}

/**
 * The role changes when a pending application ends. The pending role comes off whatever the form
 * looks like now (the row remembers which role it was, so a deleted form cannot leave it behind); the
 * form's own changes follow when it still exists. Waiting changes from earlier are replaced.
 */
function endingOps(form, sub, status, grants) {
  return mergeOps(
    sub.rolesPending,
    removeOps([sub.pendingRoleId]),
    form ? decisionOps(form, status, grants) : []
  );
}

/**
 * The roles accepting or denying `sub` would give the applicant, as the decision would work them out
 * (the form's roles, the role question's answers, changes still waiting). For the dashboard, which checks
 * them against the person deciding before the decision is made (src/web/middleware/roleGrants.js).
 * @param {'accept' | 'deny'} action
 * @returns {string[]}
 */
export function decisionGrantIds(form, sub, action) {
  const status = action === 'accept' ? 'accepted' : 'denied';
  const grants = status === 'accepted' ? questionGrants(form, sub.questions, sub.answers, 'accept').ids : [];
  return endingOps(form, sub, status, grants)
    .filter((o) => o.op === 'add')
    .map((o) => o.roleId);
}

/** The roles a retry of the waiting role changes would give. */
export function pendingGrantIds(sub) {
  return (sub.rolesPending ?? []).filter((o) => o.op === 'add').map((o) => o.roleId);
}

/** Take the pending role off a member whose pending application ends without a decision (deleted, forgotten). */
async function dropPendingRole(guild, sub) {
  if (sub.status !== 'pending' || !sub.pendingRoleId) return;
  const result = await applyRoleOps(
    guild,
    sub.userId,
    removeOps([sub.pendingRoleId]),
    `Application #${sub.id} removed`
  );
  if (result.failed.length)
    log.warn('module:applications', `could not take off a pending role (application #${sub.id})`);
}

/**
 * Apply role changes to a member. A change that is already true (has the role / lacks it) counts as
 * done, so a retry never does anything twice. A member who is not in the server any more has nothing
 * to change.
 * @returns {Promise<{ failed: Array<{ op: string, roleId: string }>, gone: boolean }>}
 */
async function applyRoleOps(guild, userId, ops, reason) {
  if (!ops.length) return { failed: [], gone: false };
  const member = await fetchMember(guild, userId);
  if (!member) return { failed: [], gone: true };
  const failed = [];
  for (const { op, roleId } of ops) {
    try {
      const has = member.roles.cache.has(roleId);
      if (op === 'add' && !has) await member.roles.add(roleId, reason);
      else if (op === 'remove' && has) await member.roles.remove(roleId, reason);
    } catch (err) {
      if (isNotFound(err, [10011, 10007])) continue; // the role (or member) is gone: nothing to do
      log.warn('module:applications', `could not ${op} a role: ${err.message}`);
      failed.push({ op, roleId });
    }
  }
  return { failed, gone: false };
}

// --- messages on the platform ------------------------------------------------------------------------------

const NEEDED_IN_CHANNEL = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'EmbedLinks'];
const missingPermission = (guild, channel) => {
  const me = guild.members?.me;
  return Boolean(me && !channel.permissionsFor?.(me)?.has(NEEDED_IN_CHANNEL));
};

async function textChannel(guild, channelId) {
  if (!channelId) return null;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    return channel?.isTextBased?.() ? channel : null;
  } catch (err) {
    if (!isMessageGone(err)) log.warn('module:applications', `could not look up a channel: ${err.message}`);
    return null;
  }
}

/**
 * Edit or delete a message by its id. 'ok', 'gone' (the platform says it does not exist), 'denied'
 * (no access, for good) or 'error' (anything else: a timeout, a 5xx). Only 'gone' means the message
 * is not there.
 * @returns {Promise<'ok' | 'gone' | 'denied' | 'error'>}
 */
async function actOnMessage(guild, channelId, messageId, action, payload) {
  if (!channelId || !messageId) return 'gone';
  let channel;
  try {
    channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
  } catch (err) {
    if (isMessageGone(err)) return 'gone';
    return isPermissionDenied(err) ? 'denied' : 'error';
  }
  if (!channel) return 'gone';
  if (!channel.isTextBased?.()) return 'denied';
  try {
    if (action === 'edit') await channel.messages.edit(messageId, payload);
    else await channel.messages.delete(messageId);
    return 'ok';
  } catch (err) {
    if (isMessageGone(err)) return 'gone';
    log.warn('module:applications', `could not ${action} a message: ${err.message}`);
    return isPermissionDenied(err) ? 'denied' : 'error';
  }
}

async function sendDm(guild, userId, content) {
  if (!content) return true;
  try {
    const user = await clientOfGuild(guild).users.fetch(userId);
    await user.send({ content: cut(content, 2000), allowedMentions: NO_MENTIONS });
    return true;
  } catch {
    return false; // DMs closed, or the person left
  }
}

/** Remember a message to the member that could not be sent, so staff see it. */
async function noteDmFailure(key, id, which) {
  const sub = await getSubmission(key, id);
  if (!sub) return;
  const have = new Set(sub.dmNote.split(',').filter(Boolean));
  have.add(which);
  await setSubmissionDmNote(key, id, [...have].join(','));
}

// --- the post ---------------------------------------------------------------------------------------------------

const buttonsFor = (id) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apps:accept:${id}`)
      .setLabel('Accept')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`apps:deny:${id}`)
      .setLabel('Deny')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

/** The warning a post shows while role changes are still waiting. */
const rolesWarning = (pending) =>
  pending.length
    ? `Sylo could not change some roles (${pending.map((p) => `${p.op === 'add' ? '+' : '−'}<@&${p.roleId}>`).join(' ')}). Retry from the dashboard.`
    : '';

/** The message of a submission: embeds, and Accept / Deny while it is pending. */
export function postPayload(sub, { ping = [], withButtons = sub.status === 'pending' } = {}) {
  const embeds = buildSubmissionEmbeds({
    submission: sub,
    applicant: `<@${sub.userId}>`,
    decidedBy: sub.decidedBy
      ? `<@${sub.decidedBy}>`
      : sub.status === 'denied' || sub.status === 'accepted'
        ? 'Sylo'
        : '',
    warning: rolesWarning(sub.rolesPending),
  }).map((e) => new EmbedBuilder(e));
  const payload = {
    embeds,
    components: withButtons ? [buttonsFor(sub.id)] : [],
    allowedMentions: ping.length ? { parse: [], roles: ping } : NO_MENTIONS,
  };
  if (ping.length) payload.content = ping.map((id) => `<@&${id}>`).join(' ');
  return payload;
}

/** Edit the post (and its copy) to match the stored submission. */
async function refreshPost(guild, key, sub) {
  const payload = postPayload(sub);
  let state = 'gone';
  if (sub.messageId) {
    state = await actOnMessage(guild, sub.channelId, sub.messageId, 'edit', { ...payload, content: '' });
    if (state === 'gone') await clearSubmissionPost(key, sub.id, sub.messageId);
  }
  if (sub.copyMessageId) {
    const copy = await actOnMessage(guild, sub.copyChannelId, sub.copyMessageId, 'edit', {
      ...payload,
      content: '',
    });
    if (copy === 'gone') await clearSubmissionCopy(key, sub.id, sub.copyMessageId);
  }
  return state;
}

/**
 * After a decision (or a withdrawal): show the new status on the post, and put the post in the
 * accepted or denied channel when the form has one: moved (the post is sent there and the old one
 * deleted) or copied (the old one stays and a copy is sent), as the form says.
 * @returns {Promise<string[]>} warnings
 */
async function settlePost(guild, key, sub, form) {
  const warnings = [];
  const target =
    sub.status === 'accepted'
      ? form?.acceptedChannelId
      : sub.status === 'denied'
        ? form?.deniedChannelId
        : '';
  const payload = { ...postPayload(sub), content: '' };
  const editHere = async () => {
    if (!sub.messageId) return;
    const state = await actOnMessage(guild, sub.channelId, sub.messageId, 'edit', payload);
    if (state === 'gone') await clearSubmissionPost(key, sub.id, sub.messageId);
    else if (state !== 'ok') warnings.push('Sylo could not update the post.');
  };
  // Copy mode and a copy exists already (an earlier settling posted it): refresh it in place, never post a
  // second one that would replace the pointer to the first.
  if (target && sub.copyMessageId && (form?.decidedPost ?? 'move') === 'copy') {
    await refreshPost(guild, key, sub);
    return warnings;
  }
  if (target && target !== sub.channelId) {
    const channel = await textChannel(guild, target);
    if (channel && !missingPermission(guild, channel)) {
      let sent = null;
      try {
        sent = await channel.send(payload);
      } catch (err) {
        log.warn('module:applications', `could not post to the decided channel: ${err.message}`);
      }
      if (sent) {
        if ((form?.decidedPost ?? 'move') === 'copy') {
          await editHere();
          await setSubmissionCopy(key, sub.id, channel.id, sent.id);
        } else {
          // The old post is deleted BEFORE the row points at the new one: while the old post is still
          // there, the row must keep pointing at it, or nothing could ever delete its answers.
          const state = sub.messageId
            ? await actOnMessage(guild, sub.channelId, sub.messageId, 'delete')
            : 'gone';
          if (state === 'ok' || state === 'gone') {
            await setSubmissionPost(key, sub.id, channel.id, sent.id);
            return warnings;
          }
          // The old post stays (a transient error or no access): take the new one back, keep the row on
          // the old one, and show the decision on it in place. If the new one cannot be taken back,
          // the row keeps its id as the copy, so /forget and the retention still find it.
          const undone = await actOnMessage(guild, channel.id, sent.id, 'delete');
          if (undone !== 'ok' && undone !== 'gone') await setSubmissionCopy(key, sub.id, channel.id, sent.id);
          warnings.push(
            'Sylo could not delete the old post, so the application stays in its channel and was not moved.'
          );
          await editHere();
          return warnings;
        }
        return warnings;
      }
    }
    warnings.push('Sylo could not post in the accepted or denied channel, so the post stays where it is.');
  }
  await editHere();
  return warnings;
}

// --- starting -----------------------------------------------------------------------------------------------------

/** Whether a form takes answers this way. */
export const allowsVia = (form, via) =>
  form.fillMode === 'both' || (via === 'dm' ? form.fillMode === 'discord' : form.fillMode === 'web');

/** The address of a form's web page, or null when this Sylo has no public address. */
export function webUrl(key, formId) {
  return appConfig.dashboardUrl
    ? `${appConfig.dashboardUrl}/apply/${encodeURIComponent(key)}/${formId}`
    : null;
}

/**
 * Everything that must hold before a member may start or submit, in order. Run when they start and
 * again when they submit.
 * @param {{ guild: any, key: string, member: any, userId: string, form: any, via: 'dm' | 'web' }} args
 * @returns {Promise<{ reason: string, text: string } | null>}
 */
export async function startProblem({ guild, key, member, userId, form, via }) {
  if (!(await isModuleEnabled(key, 'applications'))) {
    return { reason: 'module_off', text: 'Applications are off in this server.' };
  }
  if (!form || !form.enabled) return { reason: 'form_off', text: 'That form is not open for applications.' };
  if (!allowsVia(form, via)) {
    return {
      reason: 'wrong_mode',
      text:
        via === 'dm'
          ? 'That form is filled in on the web, not in DM.'
          : 'That form is filled in on Discord, not on the web.',
    };
  }
  if (formSetupProblem(form)) {
    return { reason: 'not_set_up', text: 'That form is not set up yet. Ask a server admin.' };
  }
  if (!member) return { reason: 'not_member', text: 'I could not find you in this server.' };
  const why = roleSetupProblem(guild, form);
  if (why) {
    return {
      reason: 'roles',
      text: 'That form cannot be used right now: Sylo cannot manage its roles. Ask a server admin.',
    };
  }
  return checkRequirements(form, {
    ...factsOfMember(member),
    pending: Boolean(await pendingSubmission(key, form.id, userId)),
    cooldownUntil: await getCooldownUntil(key, form.id, userId),
  });
}

const RATE_MS = 30_000;
/** @type {Map<string, number>} */
const rates = new Map();
sweepMap(rates, (at, now) => now - at > RATE_MS);
/** When a member last submitted on the web, by server and member. */
const webSubmits = new Map();
sweepMap(webSubmits, (at, now) => now - at > RATE_MS);

/** Seconds until this member may start again, or 0 (and the attempt is counted). */
export function startRateLeft(platform, userId, now = Date.now()) {
  const key = `${platform}:${userId}`;
  const last = rates.get(key);
  if (last && now - last < RATE_MS) return Math.ceil((RATE_MS - (now - last)) / 1000);
  rates.set(key, now);
  return 0;
}

const nameOf = (member, user) => member?.displayName ?? user?.globalName ?? user?.username ?? 'there';
const valuesFor = (guild, form, who, reason = '') => ({
  user: who,
  server: guild.name,
  form: form.name,
  reason: reason || 'No reason was given.',
});

function previewEmbeds(guild, form, questions, answers, userId) {
  return buildSubmissionEmbeds({
    submission: {
      id: 0,
      formName: form.name,
      status: 'pending',
      source: 'dm',
      createdAt: Date.now(),
      questions,
      answers,
      reason: '',
      dmNote: '',
      rolesPending: [],
    },
    applicant: `<@${userId}>`,
    preview: true,
  }).map((e) => new EmbedBuilder(e));
}

/**
 * Start the DM questionnaire of a form for a member.
 * @returns {Promise<{ ok: boolean, message: string }>} what to tell the member where they asked
 */
export async function startDm({ guild, user, form }) {
  const key = guildKey(guild);
  const member = await fetchMember(guild, user.id);
  const problem = await startProblem({ guild, key, member, userId: user.id, form, via: 'dm' });
  if (problem) return { ok: false, message: problem.text };

  const questions = withRoleNames(form.questions, guild);
  const header = fillTemplate(form.messages.start, valuesFor(guild, form, nameOf(member, user)));
  const started = await startQuestionnaire({
    user,
    platform: platformOfGuild(guild),
    questions: questions.map(dmQuestionOf),
    header: header || `Application: **${form.name}**`,
    review: async (answers) => ({ embeds: previewEmbeds(guild, form, questions, answers, user.id) }),
    confirmLabel: 'Submit',
    restartLabel: 'Start over',
    normalise: cleanAnswer,
    timeoutMs: form.timeoutMinutes * 60_000,
    scope: sessionScope(key, form.id),
    onComplete: async (answers) => {
      const done = await submitApplication({
        guild,
        userId: user.id,
        formId: form.id,
        questions,
        answers,
        source: 'dm',
      });
      return done.ok ? done.completed : { ok: false, message: done.error, final: done.final === true };
    },
  });
  if (started.ok) return { ok: true, message: 'Check your DMs.' };
  if (started.reason === 'busy') {
    return {
      ok: false,
      message: 'You are already answering questions in your DMs. Finish there (or type `cancel`) first.',
    };
  }
  if (started.reason === 'dm_closed') {
    return { ok: false, message: 'I could not DM you. Open your DMs from server members and try again.' };
  }
  return { ok: false, message: 'There is nothing to ask right now.' };
}

/**
 * What to answer someone who asks to apply for a form (a command, a panel button): checks, then DM,
 * a link, or a choice of both, as the form's fill mode says.
 * @returns {Promise<{ ok: boolean, content: string, components?: any[] }>}
 */
export async function beginApplication({ guild, user, form }) {
  const key = guildKey(guild);
  const member = await fetchMember(guild, user.id);
  const url = webUrl(key, form?.id);
  if (!form || !form.enabled || !(await isModuleEnabled(key, 'applications'))) {
    return { ok: false, content: 'That form is not open for applications.' };
  }
  // A form filled in on the web is checked as that; every other one is checked as a DM start.
  const probe = await startProblem({
    guild,
    key,
    member,
    userId: user.id,
    form,
    via: form.fillMode === 'web' ? 'web' : 'dm',
  });
  if (probe) return { ok: false, content: probe.text };

  if (form.fillMode === 'web') {
    if (!url)
      return {
        ok: false,
        content: 'That form is filled in on the web, but this Sylo has no public web address.',
      };
    return { ok: true, content: `Fill in **${form.name}** on the web: ${url}` };
  }
  if (form.fillMode === 'both' && url) {
    return {
      ok: true,
      // Where private replies are short-lived (Fluxer), this one holds a choice and a link: it stays for
      // as long as the DM questionnaire would run (see keepReplyFor).
      holdMs: form.timeoutMinutes * 60_000,
      content: `How do you want to apply for **${form.name}**?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`apps:dm:${form.id}`)
            .setLabel('Answer in DMs')
            .setEmoji('💬')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setLabel('Open on the web').setURL(url).setStyle(ButtonStyle.Link)
        ),
      ],
    };
  }
  const started = await startDm({ guild, user, form });
  return { ok: started.ok, content: started.message };
}

/**
 * On a platform with no private replies (Fluxer) a reply is deleted after about 15 seconds. A reply that
 * holds a choice and a link must stay longer: call this with the result's `holdMs` before replying.
 */
export function keepReplyFor(interaction, holdMs) {
  if (holdMs && typeof interaction?._privateTtlMs === 'number') {
    interaction._privateTtlMs = Math.max(interaction._privateTtlMs, holdMs);
  }
}

/** Find a form by number, exact name or a unique start of the name, among those a member can use. */
export function pickForm(forms, text) {
  const open = forms.filter((f) => f.enabled);
  const wanted = String(text ?? '').trim();
  if (!wanted) return open.length === 1 ? { form: open[0] } : { ambiguous: open };
  const byId = /^\d+$/.test(wanted) ? open.find((f) => f.id === Number(wanted)) : null;
  if (byId) return { form: byId };
  const lower = wanted.toLowerCase();
  const exact = open.filter((f) => f.name.toLowerCase() === lower);
  if (exact.length === 1) return { form: exact[0] };
  const starts = open.filter((f) => f.name.toLowerCase().startsWith(lower));
  if (starts.length === 1) return { form: starts[0] };
  return starts.length > 1 || exact.length > 1
    ? { ambiguous: starts.length ? starts : exact }
    : { form: null };
}

// --- submitting ----------------------------------------------------------------------------------------------------

/** One submit per member and form at a time. */
const chains = new Map();
async function withLock(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

const completedText = (guild, form, member, user, reason = '') =>
  fillTemplate(form.messages.completed, valuesFor(guild, form, nameOf(member, user), reason)) ||
  'Your application was submitted.';

/**
 * Store and post a submission. Everything is checked again here: the module, the form, the fill mode
 * (`source`), the requirements, the answers, and that Sylo can manage the form's roles.
 * @param {{ guild: any, userId: string, formId: number, questions?: any[], answers: Record<string, unknown>,
 *   source: 'dm' | 'web', version?: number }} args
 *   `questions` are the questions as the member was asked them (a DM session keeps its own); without
 *   them (the web form) the form's current questions are used, and `version` must still match.
 * @returns {Promise<{ ok: true, id: number, completed: string } | { ok: false, error: string, reason?: string, final?: boolean }>}
 */
export async function submitApplication({ guild, userId, formId, questions, answers, source, version }) {
  const key = guildKey(guild);
  return withLock(`submit|${key}|${formId}|${userId}`, async () => {
    const form = await loadForm(key, formId);
    const member = await fetchMember(guild, userId);
    const problem = await startProblem({ guild, key, member, userId, form, via: source });
    if (problem) {
      const final = [
        'module_off',
        'form_off',
        'wrong_mode',
        'not_member',
        'pending',
        'missing_roles',
        'restricted_role',
        'account_age',
        'server_time',
        'cooldown',
      ].includes(problem.reason);
      return { ok: false, error: problem.text, reason: problem.reason, final };
    }
    if (version !== undefined && Number(version) !== form.updatedAt) {
      return {
        ok: false,
        error: 'The form was changed while you filled it in. Reload the page and check your answers.',
        reason: 'form_changed',
      };
    }
    const asked = questions ?? withRoleNames(form.questions, guild);
    const checked = validateAnswers(asked, answers);
    if (!checked.ok) {
      return { ok: false, error: 'Some answers are not valid.', reason: 'invalid', errors: checked.errors };
    }
    // The web form is held to the same pace as starting in DM (one start per 30 seconds): without this, a
    // member could submit, withdraw and submit again, and every round posts and pings the staff channel.
    if (source === 'web') {
      const last = webSubmits.get(`${key}|${userId}`);
      if (last && Date.now() - last < RATE_MS) {
        const wait = Math.ceil((RATE_MS - (Date.now() - last)) / 1000);
        return { ok: false, error: `Please wait ${wait} seconds before you submit again.`, reason: 'rate' };
      }
    }

    let id;
    try {
      id = await insertSubmission({
        guildId: key,
        formId: form.id,
        formName: form.name,
        pendingRoleId: form.pendingRoleId,
        userId,
        source,
        questions: asked,
        answers: checked.answers,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          ok: false,
          error: 'You already have an application for this form waiting for a decision.',
          reason: 'pending',
          final: true,
        };
      }
      throw err;
    }

    // The post comes first: without it, staff never see the submission, so it is taken back.
    const channel = await textChannel(guild, form.pendingChannelId);
    let message = null;
    let failure = 'The channel for new applications is missing. Ask a server admin.';
    if (channel && missingPermission(guild, channel)) {
      failure =
        'I cannot post in the channel for new applications. Ask a server admin to check my permissions.';
    } else if (channel) {
      try {
        const sub = await getSubmission(key, id);
        message = await channel.send(postPayload(sub, { ping: form.pingRoleIds }));
      } catch (err) {
        log.warn('module:applications', `could not post a submission: ${err.message}`);
        failure = 'I could not post your application. Please try again in a moment.';
      }
    }
    if (!message) {
      await deleteSubmission(key, id);
      return { ok: false, error: failure, reason: 'post_failed' };
    }
    // The post gets its pointer under the lock of decisions, because staff may already have decided: the
    // row may be decided (then the post is settled now) or may already point at a post the decision made
    // (then this one is not needed).
    await withLock(`decide|${key}|${id}`, async () => {
      const current = await getSubmission(key, id);
      if (current?.messageId) {
        await actOnMessage(guild, channel.id, message.id, 'delete');
        return;
      }
      await setSubmissionPost(key, id, channel.id, message.id);
      if (current && current.status !== 'pending') {
        await settlePost(guild, key, { ...current, channelId: channel.id, messageId: message.id }, form);
      }
    });
    if (source === 'web') webSubmits.set(`${key}|${userId}`, Date.now());

    if (form.staffThread && guildSupports(guild, 'threads') && typeof message.startThread === 'function') {
      // A nicety: no permission, or a channel type without threads, must not undo the submission.
      const thread = await message
        .startThread({ name: cut(`${form.name} #${id}`, 100), autoArchiveDuration: 1440 })
        .catch((err) => log.debug?.('module:applications', `no thread: ${err.message}`));
      if (thread?.id) await setSubmissionThread(key, id, thread.id);
    }

    // Roles for the submit step, under the lock of decisions on this application: staff may already have
    // pressed Accept on the post. A decision that is there wins, and then the waiting role is not given.
    // A failure leaves the submission standing, with a warning on the post.
    await withLock(`decide|${key}|${id}`, async () => {
      const sub = await getSubmission(key, id);
      if (!sub) return;
      if (sub.status !== 'pending') {
        // Decided before the post had its pointer: the post still shows Accept and Deny, so it is refreshed.
        await refreshPost(guild, key, sub);
        return;
      }
      const ops = submitOps(form, sub);
      if (!ops.length) return;
      const result = await applyRoleOps(guild, userId, ops, `Application #${id} submitted`);
      if (result.failed.length) {
        const history = [
          ...sub.history,
          { at: Date.now(), by: null, action: 'roles_failed', note: 'submit' },
        ].slice(-60);
        await setSubmissionRoles(key, id, result.failed, history);
        await refreshPost(guild, key, await getSubmission(key, id));
      }
    });

    const text = completedText(guild, form, member, member?.user);
    // On the web the member is not in a DM, so the confirmation is sent as one; in a DM it is the answer.
    if (source === 'web' && !(await sendDm(guild, userId, text))) await noteDmFailure(key, id, 'completed');
    return { ok: true, id, completed: text };
  });
}

// --- deciding -----------------------------------------------------------------------------------------------------

const normaliseReason = (v) => cut(cleanAnswer(String(v ?? '')), 500);

/**
 * Accept or deny a pending submission.
 * @param {{ guild: any, id: number, action: 'accept' | 'deny', reason?: string, by?: string | null,
 *   actor: { member?: any, permissions?: any, dashboard?: true, system?: true }, memberGone?: boolean }} args
 *   `actor` says who asks: a member (checked against the form's manager roles and Manage Server), the
 *   dashboard (the route has checked the person's access level, Inbox or more, and that they may hand
 *   out every role the decision gives: decisionGrantIds) or the system (a leave).
 * @returns {Promise<{ ok: true, status: string, warnings: string[], dm: boolean } | { ok: false, error: string, code: string }>}
 */
export async function decideSubmission({
  guild,
  id,
  action,
  reason = '',
  by = null,
  actor,
  memberGone = false,
}) {
  const status = action === 'accept' ? 'accepted' : action === 'deny' ? 'denied' : null;
  if (!status) return { ok: false, error: 'Unknown action.', code: 'bad_action' };
  const key = guildKey(guild);
  return withLock(`decide|${key}|${id}`, async () => {
    const sub = await getSubmission(key, id);
    if (!sub) return { ok: false, error: `There is no application #${id} in this server.`, code: 'missing' };
    const form = await loadForm(key, sub.formId);
    const allowed =
      actor?.system === true ||
      actor?.dashboard === true ||
      canManageApplications(actor?.member, actor?.permissions, form);
    if (!allowed) {
      return {
        ok: false,
        error:
          'Only staff with Manage Server or one of this form’s manager roles can decide on applications.',
        code: 'forbidden',
      };
    }
    if (sub.status !== 'pending') {
      return { ok: false, error: `Application #${id} was already ${sub.status}.`, code: 'already' };
    }

    const cleanReason = normaliseReason(reason);
    const history = [
      ...sub.history,
      { at: Date.now(), by, action: status, note: cleanReason ? 'with a reason' : '' },
    ].slice(-60);
    // The decision itself: one conditional update, so only one caller can win. The cooldown after a denial
    // is written in the same transaction, before any platform work, so there is no moment when the
    // application is denied and the member may apply again.
    const cooldown =
      status === 'denied' && form?.cooldownHours > 0
        ? { formId: form.id, userId: sub.userId, until: Date.now() + form.cooldownHours * 3_600_000 }
        : null;
    if (!(await claimDecision(key, id, { status, by, reason: cleanReason, history, cooldown }))) {
      return { ok: false, error: `Application #${id} was already decided.`, code: 'already' };
    }
    const decided = await getSubmission(key, id);
    const warnings = [];

    // Roles. A role question gives only what the form allows now, and only what Sylo can still manage.
    // The pending role comes off even when the form is gone. This step's changes replace earlier ones
    // that are still waiting for the same role.
    if (!memberGone) {
      const wanted =
        status === 'accepted'
          ? questionGrants(form, decided.questions, decided.answers, 'accept')
          : { ids: [], skipped: [] };
      const refused = wanted.ids.filter((rid) => botRefusal(guild, guild.roles?.cache?.get?.(rid)));
      const skipped = [...wanted.skipped, ...refused];
      const granted = wanted.ids.filter((rid) => !refused.includes(rid));
      const ops = endingOps(form, decided, status, granted);
      const result = await applyRoleOps(guild, decided.userId, ops, `Application #${id} ${status}`);
      const next = result.failed;
      const more = [];
      if (next.length) more.push({ at: Date.now(), by: null, action: 'roles_failed', note: status });
      if (skipped.length)
        more.push({ at: Date.now(), by: null, action: 'roles_skipped', note: `${skipped.length}` });
      if (next.length || skipped.length || decided.rolesPending.length) {
        await setSubmissionRoles(key, id, next, [...decided.history, ...more]);
      }
      if (next.length) warnings.push('Some roles could not be changed. Retry from the dashboard.');
      if (skipped.length) {
        warnings.push(
          `Skipped ${skipped.length} role${skipped.length === 1 ? '' : 's'} the form no longer gives or Sylo cannot manage.`
        );
      }
    } else if (decided.rolesPending.length) {
      await setSubmissionRoles(key, id, [], decided.history);
    }

    const fresh = await getSubmission(key, id);
    warnings.push(...(await settlePost(guild, key, fresh, form)));

    let dm = false;
    if (!memberGone && form) {
      const member = await fetchMember(guild, decided.userId);
      const template = status === 'accepted' ? form.messages.accepted : form.messages.denied;
      const text = fillTemplate(template, valuesFor(guild, form, nameOf(member, member?.user), cleanReason));
      dm = await sendDm(guild, decided.userId, text);
      if (!dm && text) await noteDmFailure(key, id, status);
      if (!dm && text) await refreshPost(guild, key, await getSubmission(key, id));
    }
    return { ok: true, status, warnings, dm };
  });
}

/**
 * Try the role changes that failed earlier again. The ones that work are removed from the list; the
 * rest stay for the next try.
 * @returns {Promise<{ ok: true, remaining: number, applied: number } | { ok: false, error: string }>}
 */
export async function retryRoles({ guild, id }) {
  const key = guildKey(guild);
  return withLock(`decide|${key}|${id}`, async () => {
    const sub = await getSubmission(key, id);
    if (!sub) return { ok: false, error: 'No such application.' };
    if (!sub.rolesPending.length) return { ok: true, remaining: 0, applied: 0 };
    const result = await applyRoleOps(guild, sub.userId, sub.rolesPending, `Application #${id}: retry`);
    const history = [
      ...sub.history,
      { at: Date.now(), by: null, action: 'roles_retried', note: `${result.failed.length} left` },
    ];
    await setSubmissionRoles(key, id, result.failed, history);
    await refreshPost(guild, key, await getSubmission(key, id));
    return {
      ok: true,
      remaining: result.failed.length,
      applied: sub.rolesPending.length - result.failed.length,
    };
  });
}

/**
 * The applicant withdraws a pending submission. The post stays (marked withdrawn); the pending role
 * comes off.
 * @returns {Promise<{ ok: true, id: number } | { ok: false, error: string }>}
 */
export async function withdrawSubmission({ guild, userId, formId = null, formText = '' }) {
  const key = guildKey(guild);
  // A member can always take back their own pending application: it is found among theirs, whatever the
  // form's state is now (closed, DM or web only, even deleted).
  const wanted = String(formText ?? '')
    .trim()
    .toLowerCase();
  const pending = (await pendingOfUser(key, userId)).filter((s) => {
    if (formId && s.formId !== Number(formId)) return false;
    if (!wanted) return true;
    if (/^\d+$/.test(wanted)) return s.formId === Number(wanted) || s.id === Number(wanted);
    return s.formName.toLowerCase() === wanted || s.formName.toLowerCase().startsWith(wanted);
  });
  if (pending.length === 0) return { ok: false, error: 'You have no pending application.' };
  if (pending.length > 1) {
    return {
      ok: false,
      error: `You have more than one pending application (${pending.map((s) => `${s.formName} #${s.id}`).join(', ')}). Say which form.`,
    };
  }
  const { id } = pending[0];
  return withLock(`decide|${key}|${id}`, async () => {
    const sub = await getSubmission(key, id);
    const form = sub && (await loadForm(key, sub.formId));
    if (!sub || sub.status !== 'pending')
      return { ok: false, error: 'That application was decided in the meantime.' };
    const history = [...sub.history, { at: Date.now(), by: userId, action: 'withdrawn', note: '' }].slice(
      -60
    );
    if (!(await claimDecision(key, id, { status: 'withdrawn', by: userId, reason: '', history }))) {
      return { ok: false, error: 'That application was decided in the meantime.' };
    }
    const fresh = await getSubmission(key, id);
    const result = await applyRoleOps(
      guild,
      userId,
      endingOps(form, fresh, 'withdrawn', []),
      `Application #${id} withdrawn`
    );
    await setSubmissionRoles(key, id, result.failed, fresh.history);
    await refreshPost(guild, key, await getSubmission(key, id));
    return { ok: true, id };
  });
}

// --- staff buttons ---------------------------------------------------------------------------------------------------

async function handleStaffButton(interaction) {
  const [, action, rawId] = interaction.customId.split(':');
  const guild = interaction.guild;
  const eph = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  if (!guild) return undefined;
  const key = guildKey(guild);
  const sub = await getSubmissionAny(rawId);
  if (!sub || sub.guildId !== key) return eph('That application no longer exists.');
  const form = await loadForm(key, sub.formId);
  if (!canManageApplications(interaction.member, interaction.memberPermissions, form)) {
    return eph(
      'Only staff with Manage Server or one of this form’s manager roles can decide on applications.'
    );
  }
  if (sub.status !== 'pending') return eph(`This application was already ${sub.status}.`);
  await interaction.deferUpdate();
  const result = await decideSubmission({
    guild,
    id: sub.id,
    action,
    by: interaction.user.id,
    actor: { member: interaction.member, permissions: interaction.memberPermissions },
  });
  if (!result.ok) {
    // Someone else decided at the same moment: the post already shows it.
    return interaction
      .followUp({ content: result.error, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS })
      .catch(() => {});
  }
  if (result.warnings.length) {
    await interaction
      .followUp({
        content: result.warnings.join(' '),
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      })
      .catch(() => {});
  }
  return undefined;
}

registerComponent('applications', 'apps:', async (interaction) => {
  const action = interaction.customId.split(':')[1];
  if (action === 'accept' || action === 'deny') return handleStaffButton(interaction);
  if (action === 'dm') return handleDmButton(interaction);
  return undefined;
});

/** "Answer in DMs" under the reply of a form that takes both. */
async function handleDmButton(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const form = await loadForm(guildKey(guild), Number(interaction.customId.split(':')[2]));
  await interaction.deferUpdate();
  const result = form
    ? await startDm({ guild, user: interaction.user, form })
    : { message: 'That form is not open for applications.' };
  await interaction.editReply({ content: result.message, components: [], allowedMentions: NO_MENTIONS });
}

// --- the panel -----------------------------------------------------------------------------------------------------------

export const PANEL_DEFAULT_TEXT = 'Apply here! Choose a form below and Sylo guides you through it.';

function panelPayload(forms, text) {
  const open = forms.filter((f) => f.enabled && !formSetupProblem(f)).slice(0, MAX_FORMS);
  const payload = { content: text || PANEL_DEFAULT_TEXT, allowedMentions: NO_MENTIONS, components: [] };
  if (open.length <= 5) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        ...open.map((f) =>
          new ButtonBuilder()
            .setCustomId(`appp:f:${f.id}`)
            .setLabel(cut(f.name, 80))
            .setEmoji('📋')
            .setStyle(ButtonStyle.Primary)
        )
      ),
    ];
  } else {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('appp:select')
          .setPlaceholder('Choose a form')
          .addOptions(
            open.map((f) => ({
              label: cut(f.name, 100),
              value: String(f.id),
              ...(f.description ? { description: cut(f.description.replace(/\s+/g, ' '), 100) } : {}),
            }))
          )
      ),
    ];
  }
  return { open, payload };
}

/**
 * Publish the panel in a channel. A panel that exists is replaced: the new one is sent first, then
 * the old one deleted by its id.
 * @returns {Promise<{ ok: true, channelId: string, messageId: string, warning?: string } | { ok: false, error: string }>}
 */
export async function publishPanel(guild, { channelId, text }, previous = {}) {
  const key = guildKey(guild);
  const forms = await loadForms(key);
  const { open, payload } = panelPayload(forms, text);
  if (!open.length) {
    return {
      ok: false,
      error: 'Enable at least one form that has questions and a channel for new applications first.',
    };
  }
  const channel = await textChannel(guild, channelId);
  if (!channel) return { ok: false, error: 'Pick the channel for the panel first.' };
  if (missingPermission(guild, channel)) {
    return {
      ok: false,
      error: 'Sylo needs View Channel, Read Message History, Send Messages and Embed Links in that channel.',
    };
  }
  let sent;
  try {
    sent = await channel.send(payload);
  } catch (err) {
    return { ok: false, error: err.message || 'Publishing failed.' };
  }
  let warning;
  if (previous.panelMessageId) {
    const state = await actOnMessage(guild, previous.panelChannelId, previous.panelMessageId, 'delete');
    if (state !== 'ok' && state !== 'gone')
      warning = 'The new panel is published, but the old one could not be deleted.';
  }
  return { ok: true, channelId: channel.id, messageId: sent.id, ...(warning && { warning }) };
}

/** Delete the panel message. Ok when it is deleted or already gone. */
export async function unpublishPanel(guild, previous) {
  if (!previous.panelMessageId) return { ok: true };
  const state = await actOnMessage(guild, previous.panelChannelId, previous.panelMessageId, 'delete');
  if (state === 'ok' || state === 'gone') return { ok: true };
  return {
    ok: false,
    error: 'Sylo could not delete the panel message: it needs Manage Messages in that channel.',
  };
}

/** A press on the panel (a button, or a choice in the menu). */
async function handlePanel(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const raw =
    interaction.customId === 'appp:select' ? interaction.values?.[0] : interaction.customId.split(':')[2];
  const key = guildKey(guild);
  const wait = startRateLeft(platformOfGuild(guild), interaction.user.id);
  if (wait) {
    return interaction.reply({
      content: `Please wait ${wait} seconds before you start again.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const form = await loadForm(key, Number(raw));
  const result = await beginApplication({ guild, user: interaction.user, form });
  keepReplyFor(interaction, result.holdMs);
  return interaction.editReply({
    content: result.content,
    ...(result.components && { components: result.components }),
    allowedMentions: NO_MENTIONS,
  });
}
registerComponent('applications-panel', 'appp:', handlePanel);

// --- members leaving, posts deleted -------------------------------------------------------------------------------------------

on('applications', 'guildMemberRemove', async (member, _config, key) => {
  const userId = member.id ?? member.user?.id;
  const guild = guildByKey(key);
  if (!userId || !guild) return;
  // Someone who left has nothing to submit: end a questionnaire they have running for this server.
  cancelQuestionnaire(userId, 'left', {
    platform: platformOfGuild(guild),
    scopePrefix: serverScope(key),
    notify: false,
  });
  for (const sub of await pendingOfUser(key, userId)) {
    const form = await loadForm(key, sub.formId);
    if (form?.onLeave !== 'deny') continue;
    await decideSubmission({
      guild,
      id: sub.id,
      action: 'deny',
      reason: 'Left the server',
      by: null,
      actor: { system: true },
      memberGone: true,
    }).catch((err) =>
      log.warn('module:applications', `could not deny the application of a member who left: ${err.message}`)
    );
  }
});

async function forgetPostPointer(key, messageId) {
  const row = await submissionByMessage(key, messageId);
  if (!row) return;
  // Only while the row still points at that id: a move may have pointed it at a new post meanwhile.
  if (row.messageId === messageId) await clearSubmissionPost(key, row.id, messageId);
  if (row.copyMessageId === messageId) await clearSubmissionCopy(key, row.id, messageId);
}
on('applications', 'messageDelete', (message, _config, key) => forgetPostPointer(key, message.id));
on('applications', 'messageDeleteBulk', async ({ messages }, _config, key) => {
  for (const id of messages?.keys?.() ?? []) await forgetPostPointer(key, id);
});

// --- privacy -----------------------------------------------------------------------------------------------------------------

/**
 * Delete the posts (and staff thread) of a submission. 'ok' when they are deleted or gone, 'failed'
 * when one could not be deleted (it is still public), so the caller keeps the ids.
 */
async function deletePosts(guild, sub) {
  let failed = false;
  for (const [channelId, messageId] of [
    [sub.channelId, sub.messageId],
    [sub.copyChannelId, sub.copyMessageId],
  ]) {
    if (!messageId) continue;
    const state = await actOnMessage(guild, channelId, messageId, 'delete');
    if (state !== 'ok' && state !== 'gone') failed = true;
  }
  if (sub.threadId) {
    try {
      const thread = guild.channels.cache.get(sub.threadId) ?? (await guild.channels.fetch(sub.threadId));
      if (thread) await thread.delete('Application removed');
    } catch (err) {
      if (!isMessageGone(err)) failed = true;
    }
  }
  return failed ? 'failed' : 'ok';
}

/**
 * Delete a member's submissions' posts before /forget deletes their rows. Never throws. The rows whose
 * posts could not be deleted are listed in `failedIds`: forgetUser keeps those rows without their
 * answers (the ids are what lets the posts be deleted later).
 * @returns {Promise<{ ok: boolean, failedIds: number[] }>}
 */
export async function forgetApplicationPosts(guild, userId) {
  const key = guildKey(guild);
  const failedIds = [];
  try {
    for (const sub of await allSubmissionsOfUser(key, userId)) {
      // A pending application that goes away must not leave its waiting role on the member.
      await dropPendingRole(guild, sub);
      if ((await deletePosts(guild, sub)) === 'failed') failedIds.push(sub.id);
    }
  } catch (err) {
    log.warn('module:applications', `could not delete the posts of a member: ${err.message}`);
    return { ok: false, failedIds: (await allSubmissionsOfUser(key, userId)).map((s) => s.id) };
  }
  return { ok: failedIds.length === 0, failedIds };
}

/** The staff view of a submission's applicant row: its posts are deleted, then the row. */
export async function deleteSubmissionWithPosts(guild, id) {
  const key = guildKey(guild);
  const sub = await getSubmission(key, id);
  if (!sub) return { ok: false, error: 'No such application.' };
  await dropPendingRole(guild, sub);
  if ((await deletePosts(guild, sub)) === 'failed') {
    // Still public: erase the answers now and keep the ids for a later delete.
    await clearSubmissionAnswers(key, id);
    return {
      ok: false,
      error: 'The post could not be deleted, so the answers were erased and the row was kept.',
    };
  }
  await deleteSubmission(key, id);
  return { ok: true };
}

/**
 * The daily sweep: decided submissions older than their server's retention (default 180 days, at least
 * 7) are deleted with their posts; a post that cannot be deleted costs the row its answers (kept for a
 * later try); rows whose answers were erased get their posts deleted once Sylo can reach them; cooldowns
 * that have run out are dropped. Pending submissions are never touched.
 * @returns {Promise<{ deleted: number, cleared: number, cooldowns: number }>}
 */
export async function sweepApplications(now = Date.now()) {
  let deleted = 0;
  let cleared = 0;
  const minDays = LIMITS.retentionDays.min;
  for (const guildId of await guildsWithDecidedBefore(now - minDays * DAY_MS)) {
    const guild = guildByKey(guildId);
    if (!guild) continue; // that platform is not connected right now: try again tomorrow
    const { retentionDays } = await applicationsConfig(guildId);
    const cutoff = now - retentionDays * DAY_MS;
    for (const sub of await decidedBeforeInGuild(guildId, cutoff, 200)) {
      if ((await deletePosts(guild, sub)) === 'ok') {
        await deleteSubmission(guildId, sub.id);
        deleted += 1;
      } else {
        // The post cannot be deleted now: the answers go (as for /forget), the ids stay for a later try, and
        // the row leaves this batch (decidedBeforeInGuild skips cleared rows), so it cannot hold up the rest.
        await clearSubmissionAnswers(guildId, sub.id);
        cleared += 1;
      }
    }
  }
  // Rows kept without their answers: delete their posts when they can be reached again.
  for (const sub of await clearedSubmissions(200)) {
    const guild = guildByKey(sub.guildId);
    if (!guild) continue;
    if ((await deletePosts(guild, sub)) === 'ok') {
      await deleteSubmission(sub.guildId, sub.id);
      deleted += 1;
    } else {
      await touchSubmission(sub.guildId, sub.id); // to the back of the line
    }
  }
  const cooldowns = await pruneCooldowns(now);
  return { deleted, cleared, cooldowns };
}

every('applications', DAY_MS, () => sweepApplications(), { firstDelayMs: 10 * 60_000 });

// Exported for the dashboard routes.
export { displayAnswer, getSubmission, getCooldownUntil };
export const _resetApplications = () => {
  chains.clear();
  rates.clear();
  webSubmits.clear();
};
