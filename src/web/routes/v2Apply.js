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
import { Router } from 'express';
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

const router = Router({ mergeParams: true });

/** A submit may post to the platform and change roles, so it has its own limit: per person and server. */
const submitLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many submissions: wait a minute and try again.',
  keyFn: (req) => `apply-submit|${req.params?.guildId ?? ''}|${req.account?.id ?? clientKey(req)}`,
});

const notFound = (res) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return res.status(404).json({ error: 'Not found' });
};

/** Who this request may be, or null for the one not-found answer: `{ guild, key, member, form }`. */
async function openForm(req) {
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
  if (!(await isModuleEnabled(key, 'applications'))) return null;

  const form = await loadForm(key, Number(req.params.formId));
  // A form that is off, or filled in on Discord only, has no web form.
  if (!form || !form.enabled || !allowsVia(form, 'web')) return null;

  const member =
    guild.members.cache.get(identity.platformUserId) ??
    (await guild.members.fetch(identity.platformUserId).catch(() => null));
  if (!member || member.user?.bot) return null;
  return { guild, key: guildKey(guild), member, form };
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
async function formView({ guild, key, member, form }) {
  const problem = await startProblem({ guild, key, member, userId: member.id, form, via: 'web' });
  const pending = await pendingSubmission(key, form.id, member.id);
  const base = {
    guild: { name: guild.name, id: key },
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

const guard = (handler) =>
  asyncHandler(async (req, res) => {
    const open = await openForm(req);
    if (!open) return notFound(res);
    res.set({ 'Cache-Control': 'private, no-store' });
    return handler(req, res, open);
  });

router.get(
  '/:formId',
  guard(async (req, res, open) => {
    res.json(await formView(open));
  })
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
  guard(async (req, res, open) => {
    const out = await withdrawSubmission({ guild: open.guild, userId: open.member.id, formId: open.form.id });
    if (!out.ok) return res.status(400).json({ error: out.error, view: await formView(open) });
    return res.json({ ok: true, id: out.id, view: await formView(open) });
  })
);

export default router;
