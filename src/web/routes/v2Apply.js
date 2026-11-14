// The web form of an application: /api/v2/apply/<server>/<form> for the page /apply/<server>/<form>
// (which opens /v2/apply/..., like the web shop). A signed-in member of the server fills in the form
// here instead of in DM, and the answers go through the very same submitApplication() as the DM
// questionnaire: the same checks (requirements, answers, one pending, roles), the same post.
//
// Nothing here is public, and every visitor who may not use it gets the SAME answer, a 404:
//   - not signed in with the browser session (an app token does not count), or open mode with no login
//   - the server is unknown to Sylo, or has no Applications module on, or the form is missing or off
//   - the form is filled in on Discord only: it has no web form
//   - the signed-in person is not a member of that server (checked on the platform the server is on,
//     with their identity on THAT platform, so a Discord id is never looked up in a Fluxer server)
// The only thing a signed-out visitor sees is the login page the dashboard sends everyone to.
// A member who does not meet a requirement is told why (they are in the server, so it is no secret).
// Writes need the CSRF token (the global csrf middleware) and have their own rate limit. Drafts live in
// the browser only: nothing is stored here until the member submits.
import { accessRouter } from '../middleware/access.js';
import { config as appConfig } from '../../config.js';
import { rateLimit, clientKey } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildByKey, guildKey } from '../../platform/platformOf.js';
import { isPlatformGuildId, splitPlatformGuildId } from '../../lib/platformId.js';
import { identityFor } from '../lib/accountAuth.js';
import { isModuleEnabled } from '../../db/modules.js';
import { pendingSubmission } from '../../db/applications.js';
import {
  allowsVia,
  loadForm,
  startProblem,
  submitApplication,
  withRoleNames,
  withdrawSubmission,
} from '../../modules/applications.js';
import { fillTemplate } from '../../modules/lib/applicationsForm.js';

const router = accessRouter('/apply/:guildId', { mergeParams: true });

/** A submit may post to the platform and change roles, so it has its own limit: per person and server. */
const submitLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many submissions: wait a minute and try again.',
  keyFn: (req) => `apply-submit|${req.params?.guildId ?? ''}|${req.account?.id ?? clientKey(req)}`,
});

/** Withdrawing posts to the platform too (it edits the post), so it is limited like submitting. */
const withdrawLimit = rateLimit({
  windowMs: 60_000,
  max: 6,
  message: 'Too many tries: wait a minute and try again.',
  keyFn: (req) => `apply-withdraw|${req.params?.guildId ?? ''}|${req.account?.id ?? clientKey(req)}`,
});

const notFound = (res) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return res.status(404).json({ error: 'Not found' });
};

/**
 * Who this request may be, or null for the one not-found answer: `{ guild, key, member, form }`.
 * `lenient` (the page, and withdrawing): a member who has a pending application for the form may also
 * open it when the form is closed, DM only, deleted or the module is off, with `limited: true` and no form
 * to fill in: they can always see and take back their own application.
 */
async function openForm(req, { lenient = false } = {}) {
  if (!appConfig.authEnabled) return null;
  // Only the browser's own session counts, never an app (Bearer) token.
  if (!req.account || req.viaToken) return null;
  const key = req.params.guildId;
  if (!isPlatformGuildId(key)) return null;
  if (!/^\d{1,15}$/.test(String(req.params.formId ?? ''))) return null;
  const guild = guildByKey(key);
  if (!guild) return null;
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  const identity = identityFor(req.account, platform);
  if (!identity) return null;
  const strict = await isModuleEnabled(key, 'applications');

  const form = await loadForm(key, Number(req.params.formId));
  // A form that is off, or filled in on Discord only, has no web form.
  const usable = strict && form && form.enabled && allowsVia(form, 'web');
  if (!usable && !lenient) return null;

  const member =
    guild.members.cache.get(identity.platformUserId) ??
    (await guild.members.fetch(identity.platformUserId).catch(() => null));
  if (!member || member.user?.bot) return null;
  if (usable) return { guild, key: guildKey(guild), member, form };
  const own = await pendingSubmission(key, Number(req.params.formId), member.id);
  if (!own) return null;
  return { guild, key: guildKey(guild), member, form: form ?? null, own, limited: true };
}

/** The questions as the page needs them (never what a role question grants). */
const publicQuestion = (q) => ({
  id: q.id,
  type: q.type,
  label: q.label,
  help: q.help,
  required: q.required,
  long: q.long,
  minLength: q.minLength,
  maxLength: q.maxLength,
  multiple: q.multiple,
  minChoices: q.minChoices,
  maxChoices: q.maxChoices,
  options: q.options.map((o) => ({ id: o.id, label: o.label })),
});

/** The page's data: the form and its questions, or why this member cannot fill it in now. */
async function formView({ guild, key, member, form, own, limited }) {
  if (limited) {
    return {
      guild: { name: guild.name, id: key },
      viewer: member.id,
      form: { id: own.formId, name: own.formName, description: '', version: 0, intro: '' },
      pending: { id: own.id, createdAt: own.createdAt },
      problem: {
        reason: 'form_closed',
        text: 'This form is not taking applications now. You can still withdraw yours.',
      },
      questions: [],
    };
  }
  const problem = await startProblem({ guild, key, member, userId: member.id, form, via: 'web' });
  const pending = await pendingSubmission(key, form.id, member.id);
  const base = {
    guild: { name: guild.name, id: key },
    // whose draft the page may restore (drafts are kept in the browser, per person)
    viewer: member.id,
    form: {
      id: form.id,
      name: form.name,
      description: form.description,
      version: form.updatedAt,
      intro: fillTemplate(form.messages.start, {
        user: member.displayName ?? member.user?.username ?? '',
        server: guild.name,
        form: form.name,
      }),
    },
    pending: pending ? { id: pending.id, createdAt: pending.createdAt } : null,
  };
  if (problem) return { ...base, problem: { reason: problem.reason, text: problem.text }, questions: [] };
  return { ...base, problem: null, questions: withRoleNames(form.questions, guild).map(publicQuestion) };
}

const guard = (handler, opts) =>
  asyncHandler(async (req, res) => {
    const open = await openForm(req, opts);
    if (!open) return notFound(res);
    res.set({ 'Cache-Control': 'private, no-store' });
    return handler(req, res, open);
  });

router.get(
  '/:formId',
  guard(
    async (req, res, open) => {
      res.json(await formView(open));
    },
    { lenient: true }
  )
);

router.post(
  '/:formId/submit',
  asyncHandler(async (req, res, next) => {
    // The limit counts only people who may use the form: a stranger gets the plain 404 below.
    const open = await openForm(req);
    if (!open) return notFound(res);
    return submitLimit(req, res, async () => {
      try {
        res.set({ 'Cache-Control': 'private, no-store' });
        const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
        const version = /^\d{1,16}$/.test(String(req.body?.version ?? '')) ? Number(req.body.version) : NaN;
        const out = await submitApplication({
          guild: open.guild,
          userId: open.member.id,
          formId: open.form.id,
          answers,
          source: 'web',
          // a missing or odd version never matches: the page must say which form it showed
          version: Number.isFinite(version) ? version : -1,
        });
        if (!out.ok) {
          const status = out.reason === 'form_changed' ? 409 : 400;
          // never what was typed: only the reason, the per-question messages and a fresh view
          return res.status(status).json({
            error: out.error,
            reason: out.reason ?? 'refused',
            ...(out.errors && { errors: out.errors }),
            view: await formView(open),
          });
        }
        return res.json({ ok: true, id: out.id, view: await formView(open) });
      } catch (err) {
        return next(err);
      }
    });
  })
);

router.post(
  '/:formId/withdraw',
  asyncHandler(async (req, res, next) => {
    // Anyone with a pending application of their own may withdraw it, whatever state the form is in.
    const open = await openForm(req, { lenient: true });
    if (!open) return notFound(res);
    return withdrawLimit(req, res, async () => {
      try {
        res.set({ 'Cache-Control': 'private, no-store' });
        const out = await withdrawSubmission({
          guild: open.guild,
          userId: open.member.id,
          formId: Number(req.params.formId),
        });
        const again = (await openForm(req, { lenient: true })) ?? null;
        const view = again ? await formView(again) : null;
        if (!out.ok) return res.status(400).json({ error: out.error, view });
        return res.json({ ok: true, id: out.id, view });
      } catch (err) {
        return next(err);
      }
    });
  })
);

export default router;
