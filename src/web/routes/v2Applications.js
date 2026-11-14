// JSON API for the Applications page of the dashboard: the forms (create, edit, delete, order), the
// panel message, the submissions (list, detail, accept or deny with a reason, retry roles, delete), a
// member's history and the export. The rules live in modules/applications.js and
// modules/lib/applicationsForm.js.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller manages
// this server and the state-changing calls have passed the CSRF check. Every call is staff-only: a
// submission holds personal answers.
import { accessRouter } from '../middleware/access.js';
import { config as appConfig } from '../../config.js';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import { checkRoleGrants } from '../middleware/roleGrants.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { setGuildModule } from '../../db/modules.js';
import {
  deleteForm,
  exportSubmissions,
  formCount,
  getForm,
  insertForm,
  listSubmissions,
  pendingCount,
  reorderForms,
  STATUSES,
  submissionsOfUser,
  updateForm,
} from '../../db/applications.js';
import {
  DEFAULT_RETENTION_DAYS,
  MAX_FORMS,
  PLACEHOLDERS,
  PANEL_DEFAULT_TEXT,
  applicationsConfig,
  cancelFormSessions,
  decideSubmission,
  deleteSubmissionWithPosts,
  getSubmission,
  loadForm,
  loadForms,
  normaliseApplicationsConfig,
  normaliseForm,
  publishPanel,
  retryRoles,
  roleSetupProblem,
  unpublishPanel,
  withRoleNames,
} from '../../modules/applications.js';
import {
  DEFAULT_MESSAGES,
  SHORT_TEXT_MAX,
  displayAnswer,
  exportCsv,
  exportJson,
  formSetupProblem,
} from '../../modules/lib/applicationsForm.js';
import { guildSupports } from '../../platform/platformOf.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const PAGE = 25;

const savedConfig = async (key) => applicationsConfig(key);

/** A form as the dashboard sees it: the settings, its version and what is still missing. */
function formView(form, guild) {
  const settings = { ...form };
  for (const key of ['guildId', 'sortOrder', 'updatedAt']) delete settings[key];
  return {
    ...settings,
    version: form.updatedAt,
    problems: { setup: formSetupProblem(form), roles: roleSetupProblem(guild, form) },
  };
}

/** Role labels of a form's role questions, filled in from the server's role names. */
const withNames = (form, guild) => ({ ...form, questions: withRoleNames(form.questions, guild) });

const nameOf = (guild, userId) => {
  if (!userId) return null;
  const member = guild.members?.cache?.get?.(userId);
  return member?.displayName ?? member?.user?.username ?? null;
};

const roleName = (guild, id) => guild.roles?.cache?.get?.(id)?.name ?? null;

/** A submission as the dashboard sees it. `full` adds the answers and the history. */
function submissionView(sub, guild, { full = false } = {}) {
  const base = {
    id: sub.id,
    formId: sub.formId,
    formName: sub.formName,
    userId: sub.userId,
    userName: nameOf(guild, sub.userId),
    status: sub.status,
    source: sub.source,
    createdAt: sub.createdAt,
    decidedAt: sub.decidedAt,
    decidedBy: sub.decidedBy,
    decidedByName: nameOf(guild, sub.decidedBy),
    reason: sub.reason,
    dmNote: sub.dmNote,
    cleared: sub.cleared,
    hasPost: Boolean(sub.messageId),
    rolesPending: sub.rolesPending.map((p) => ({
      op: p.op,
      roleId: p.roleId,
      roleName: roleName(guild, p.roleId),
    })),
  };
  if (!full) return base;
  return {
    ...base,
    answers: sub.questions.map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      answer: displayAnswer(q, sub.answers?.[q.id]),
    })),
    history: sub.history.map((h) => ({
      at: h.at,
      by: h.by ?? null,
      byName: nameOf(guild, h.by),
      action: h.action,
      note: h.note ?? '',
    })),
  };
}

/** The roles a form hands out (not takes away): what the acting person must be allowed to hand out. */
const grantedRoles = (form) => [
  form.pendingRoleId,
  ...form.acceptAddRoleIds,
  ...form.denyAddRoleIds,
  ...form.questions
    .filter((q) => q.type === 'role' && q.grant !== 'never')
    .flatMap((q) => q.options.map((o) => o.id)),
];

// --- settings and forms --------------------------------------------------------------------------------------------

router.get(
  '/modules/applications/config',
  asyncHandler(async (req, res) => {
    const key = req.guild.id;
    const cfg = await savedConfig(key);
    const forms = await loadForms(key);
    res.json({
      config: cfg,
      forms: forms.map((f) => formView(withNames(f, req.guild), req.guild)),
      maxForms: MAX_FORMS,
      shortTextMax: SHORT_TEXT_MAX,
      defaultMessages: DEFAULT_MESSAGES,
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
      defaultPanelText: PANEL_DEFAULT_TEXT,
      placeholders: PLACEHOLDERS,
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      pending: await pendingCount(key),
      webAddress: appConfig.dashboardUrl ? `${appConfig.dashboardUrl}/apply/${key}/<form>` : null,
      threads: guildSupports(req.guild, 'threads'),
    });
  })
);

// The module's own settings: the retention and the panel text. Which message the panel is published as
// is the server's to track, not the form's.
router.post(
  '/modules/applications/config',
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    const config = normaliseApplicationsConfig({
      ...req.body,
      panelChannelId: prev.panelChannelId,
      panelMessageId: prev.panelMessageId,
    });
    await setGuildModule(req.guild.id, 'applications', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:applications',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

/** Read a form body, refuse what cannot be saved, and answer with the normalised form. */
function readForm(req, res) {
  const form = normaliseForm(req.body);
  if (!form.name) {
    res.status(400).json({ error: 'Give the form a name.' });
    return null;
  }
  // A required choice or role question with no options could never be answered.
  const stuck = form.questions.find((q) => q.unanswerable);
  if (stuck) {
    res.status(400).json({ error: `The question "${stuck.label}" is required but has no options.` });
    return null;
  }
  if (form.enabled) {
    const problem = formSetupProblem(form);
    if (problem) {
      res.status(400).json({ error: `The form cannot be enabled yet: ${problem}` });
      return null;
    }
  }
  return withNames(form, req.guild);
}

router.post(
  '/applications/forms',
  asyncHandler(async (req, res) => {
    const key = req.guild.id;
    if ((await formCount(key)) >= MAX_FORMS) {
      return res.status(400).json({ error: `A server can have at most ${MAX_FORMS} forms.` });
    }
    const form = readForm(req, res);
    if (!form) return undefined;
    await checkRoleGrants(grantedRoles(form));
    const id = await insertForm({
      guildId: key,
      name: form.name,
      enabled: form.enabled,
      fillMode: form.fillMode,
      config: form,
    });
    await recordAudit(key, {
      actor: actor(req),
      action: 'module:applications',
      detail: `created the form ${form.name}`,
    });
    return res.json({ form: formView(await loadForm(key, id), req.guild) });
  })
);

router.post(
  '/applications/forms/reorder',
  asyncHandler(async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    await reorderForms(req.guild.id, ids);
    res.json({ forms: (await loadForms(req.guild.id)).map((f) => formView(f, req.guild)) });
  })
);

router.post(
  '/applications/forms/:id',
  asyncHandler(async (req, res) => {
    const key = req.guild.id;
    const prev = await loadForm(key, req.params.id);
    if (!prev) return res.status(404).json({ error: 'No such form.' });
    const form = readForm(req, res);
    if (!form) return undefined;
    // Only roles that are new in this save need the acting person's rights.
    const had = new Set(grantedRoles(prev));
    await checkRoleGrants(grantedRoles(form).filter((id) => id && !had.has(id)));
    await updateForm(key, prev.id, {
      name: form.name,
      enabled: form.enabled,
      fillMode: form.fillMode,
      config: form,
    });
    if (!form.enabled) cancelFormSessions(key, prev.id);
    await recordAudit(key, {
      actor: actor(req),
      action: 'module:applications',
      detail: `saved the form ${form.name}`,
    });
    return res.json({ form: formView(await loadForm(key, prev.id), req.guild) });
  })
);

router.post(
  '/applications/forms/:id/delete',
  asyncHandler(async (req, res) => {
    const key = req.guild.id;
    const form = await getForm(key, req.params.id);
    if (!form) return res.status(404).json({ error: 'No such form.' });
    await deleteForm(key, form.id);
    cancelFormSessions(key, form.id);
    await recordAudit(key, {
      actor: actor(req),
      action: 'module:applications',
      detail: `deleted the form ${form.name}`,
    });
    return res.json({ ok: true });
  })
);

// --- the panel -----------------------------------------------------------------------------------------------------------

router.post(
  '/applications/panel/publish',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    const channelId = /^\d{17,20}$/.test(req.body?.channelId ?? '')
      ? req.body.channelId
      : prev.panelChannelId;
    const text = typeof req.body?.text === 'string' ? req.body.text : prev.panelText;
    const result = await publishPanel(req.guild, { channelId, text }, prev);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const config = normaliseApplicationsConfig({
      ...prev,
      panelText: text,
      panelChannelId: result.channelId,
      panelMessageId: result.messageId,
    });
    await setGuildModule(req.guild.id, 'applications', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:applications',
      detail: 'published the panel',
    });
    return res.json({ config, ...(result.warning && { warning: result.warning }) });
  })
);

router.post(
  '/applications/panel/unpublish',
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    const removed = await unpublishPanel(req.guild, prev);
    if (!removed.ok) return res.status(502).json({ error: removed.error });
    const config = { ...prev, panelChannelId: '', panelMessageId: '' };
    await setGuildModule(req.guild.id, 'applications', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:applications',
      detail: 'removed the panel',
    });
    return res.json({ config });
  })
);

// --- submissions -----------------------------------------------------------------------------------------------------------

router.get(
  '/applications/submissions',
  asyncHandler(async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const formId = /^\d{1,15}$/.test(String(req.query.formId ?? '')) ? Number(req.query.formId) : undefined;
    const userId = /^\d{17,20}$/.test(String(req.query.userId ?? '')) ? String(req.query.userId) : undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const { rows, total } = await listSubmissions({
      guildId: req.guild.id,
      formId,
      status,
      userId,
      limit: PAGE,
      offset: (page - 1) * PAGE,
    });
    res.json({ submissions: rows.map((s) => submissionView(s, req.guild)), total, page, pageSize: PAGE });
  })
);

router.get(
  '/applications/submissions/:id',
  asyncHandler(async (req, res) => {
    const sub = await getSubmission(req.guild.id, req.params.id);
    if (!sub) return res.status(404).json({ error: 'No such application.' });
    return res.json({ submission: submissionView(sub, req.guild, { full: true }) });
  })
);

router.post(
  '/applications/submissions/:id/decide',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const action = req.body?.action === 'accept' ? 'accept' : req.body?.action === 'deny' ? 'deny' : null;
    if (!action) return res.status(400).json({ error: 'Choose accept or deny.' });
    const id = Number(req.params.id);
    const result = await decideSubmission({
      guild: req.guild,
      id,
      action,
      reason: req.body?.reason,
      by: actingUserId(req, req.guild.id, null),
      actor: { dashboard: true },
    });
    if (!result.ok) return res.status(result.code === 'missing' ? 404 : 409).json({ error: result.error });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:applications',
      detail: `${result.status} application #${id}`,
    });
    const sub = await getSubmission(req.guild.id, id);
    return res.json({
      ok: true,
      warnings: result.warnings,
      dm: result.dm,
      submission: submissionView(sub, req.guild, { full: true }),
    });
  })
);

router.post(
  '/applications/submissions/:id/retry-roles',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await retryRoles({ guild: req.guild, id });
    if (!result.ok) return res.status(404).json({ error: result.error });
    const sub = await getSubmission(req.guild.id, id);
    return res.json({ ...result, submission: submissionView(sub, req.guild, { full: true }) });
  })
);

router.post(
  '/applications/submissions/:id/delete',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await deleteSubmissionWithPosts(req.guild, id);
    if (!result.ok)
      return res.status(result.error === 'No such application.' ? 404 : 502).json({ error: result.error });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:applications',
      detail: `deleted application #${id}`,
    });
    return res.json({ ok: true });
  })
);

// One member's applications, newest first (their answers are in the detail of each).
router.get(
  '/applications/members/:userId',
  asyncHandler(async (req, res) => {
    if (!/^\d{17,20}$/.test(req.params.userId)) return res.status(400).json({ error: 'Not a member id.' });
    const rows = await submissionsOfUser(req.guild.id, req.params.userId, 100);
    return res.json({
      userId: req.params.userId,
      userName: nameOf(req.guild, req.params.userId),
      submissions: rows.map((s) => submissionView(s, req.guild)),
    });
  })
);

// --- export --------------------------------------------------------------------------------------------------------------------

// A download of the answers of one form (optionally one status) as CSV or JSON. The answers are personal
// data: it is staff-only (the guard above) and every download is logged (who, which form, how many rows),
// never the content.
router.get(
  '/applications/export',
  asyncHandler(async (req, res) => {
    const form = await getForm(req.guild.id, req.query.formId);
    if (!form) return res.status(404).json({ error: 'No such form.' });
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const rows = await exportSubmissions({ guildId: req.guild.id, formId: form.id, status });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'applications:export',
      detail: `exported ${rows.length} answer set${rows.length === 1 ? '' : 's'} of form #${form.id}${status ? ` (${status})` : ''} as ${format.toUpperCase()}`,
    });
    const body = format === 'json' ? exportJson(rows) : exportCsv(rows);
    res.set({
      'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="applications-form-${form.id}${status ? `-${status}` : ''}.${format}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(format === 'json' ? body : `${String.fromCharCode(0xfeff)}${body}`);
  })
);

export default router;
