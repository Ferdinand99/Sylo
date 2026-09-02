// Public (no-auth) ban-appeal page. A banned user opens the signed link from
// their DM, answers the guild's questions, and the appeal lands in the
// dashboard's Appeals tab for staff to accept or deny. Reopening the same link
// later shows the decision — notification never depends on a DM getting through.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { log } from '../../lib/log.js';
import {
  verifyAppealToken,
  normaliseAppealsConfig,
  cooldownRemainingMs,
  announceNewAppeal,
} from '../../modules/appeals.js';
import { getOpenAppeal, getLatestAppeal, createAppeal, getAppeal } from '../../db/appeals.js';

const router = Router();

function render(res, state, extra = {}) {
  const status = state === 'error' ? 400 : 200;
  res.status(status).render('appeal', {
    state,
    guildName: null,
    questions: [],
    token: null,
    guildId: null,
    message: null,
    verdict: null,
    decisionReason: null,
    reappealDays: 0,
    serverInvite: null,
    rejoinInvite: null,
    ...extra,
  });
}

/**
 * Resolve the token + guild + module and work out which state to show.
 * @returns {{ error?: string, state?: string, message?: string, guild?: any,
 *   cfg?: any, parsed?: any, verdict?: string, decisionReason?: string,
 *   reappealDays?: number }}
 */
async function resolve(req) {
  const { guildId } = req.params;
  const parsed = verifyAppealToken(req.query.t ?? req.body.t);
  if (!parsed || parsed.guildId !== guildId) {
    return { error: 'This appeal link is invalid or has expired. Contact the server staff for a new one.' };
  }
  if (!isModuleEnabled(guildId, 'appeals')) {
    return { error: 'This server is not accepting ban appeals right now.' };
  }
  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild) return { error: 'That server could not be found.' };
  const cfg = normaliseAppealsConfig(getGuildModule(guildId, 'appeals').config);

  if (getOpenAppeal(guildId, parsed.userId)) {
    return {
      state: 'pending',
      message:
        'Your appeal has been received and is waiting for a moderator to review it. Come back to this link to see the decision.',
      guild,
      cfg,
    };
  }

  const latest = getLatestAppeal(guildId, parsed.userId);
  const banned = await guild.bans
    .fetch(parsed.userId)
    .then(() => true)
    .catch(() => false);

  // Not banned any more → show the outcome of the last appeal, if there was one.
  if (!banned) {
    if (latest?.status === 'accepted') {
      return {
        state: 'decided',
        verdict: 'accepted',
        decisionReason: latest.decision_reason || 'No note was left.',
        rejoinInvite: latest.invite_url || null,
        guild,
        cfg,
      };
    }
    if (latest?.status === 'denied') {
      return {
        state: 'decided',
        verdict: 'denied',
        decisionReason: latest.decision_reason || 'No reason was given.',
        reappealDays: 0,
        guild,
        cfg,
      };
    }
    return {
      state: 'decided',
      verdict: 'notbanned',
      decisionReason: 'You are not banned from this server, so there is nothing to appeal.',
      guild,
      cfg,
    };
  }

  // Still banned. A recent denial holds them off until the cooldown passes;
  // a past acceptance doesn't (they were banned again since) — let them appeal.
  if (latest?.status === 'denied') {
    const waitMs = cooldownRemainingMs(latest, cfg.cooldownDays);
    if (waitMs > 0) {
      return {
        state: 'decided',
        verdict: 'denied',
        decisionReason: latest.decision_reason || 'No reason was given.',
        reappealDays: Math.ceil(waitMs / 86_400_000),
        guild,
        cfg,
      };
    }
  }

  return { state: 'form', guild, cfg, parsed };
}

const inviteOf = (r) => r.cfg?.appealServerInvite || null;

router.get('/:guildId', async (req, res, next) => {
  try {
    const r = await resolve(req);
    if (r.error) return render(res, 'error', { message: r.error });
    if (r.state !== 'form') {
      return render(res, r.state, {
        message: r.message ?? null,
        guildName: r.guild?.name ?? null,
        verdict: r.verdict ?? null,
        decisionReason: r.decisionReason ?? null,
        reappealDays: r.reappealDays ?? 0,
        serverInvite: inviteOf(r),
        rejoinInvite: r.rejoinInvite ?? null,
      });
    }
    render(res, 'form', {
      guildName: r.guild.name,
      questions: r.cfg.questions,
      token: req.query.t,
      guildId: req.params.guildId,
      serverInvite: inviteOf(r),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:guildId', async (req, res, next) => {
  try {
    const r = await resolve(req);
    if (r.error) return render(res, 'error', { message: r.error });
    if (r.state !== 'form') {
      return render(res, r.state, {
        message: r.message ?? null,
        guildName: r.guild?.name ?? null,
        verdict: r.verdict ?? null,
        decisionReason: r.decisionReason ?? null,
        reappealDays: r.reappealDays ?? 0,
        serverInvite: inviteOf(r),
        rejoinInvite: r.rejoinInvite ?? null,
      });
    }

    const { guild, cfg, parsed } = r;
    const raw = [].concat(req.body.a ?? []);
    const answers = cfg.questions.map((q, i) => ({
      q,
      a: String(raw[i] ?? '')
        .trim()
        .slice(0, 2000),
    }));
    if (!answers.some((qa) => qa.a !== '')) {
      return render(res, 'form', {
        guildName: guild.name,
        questions: cfg.questions,
        token: req.body.t,
        guildId: req.params.guildId,
        serverInvite: cfg.appealServerInvite || null,
        message: 'Please answer at least one question before submitting.',
      });
    }

    const banReason = await guild.bans
      .fetch(parsed.userId)
      .then((b) => b.reason ?? '')
      .catch(() => '');
    const userTag = await guild.client.users
      .fetch(parsed.userId)
      .then((u) => u.tag)
      .catch(() => '');

    const appealId = createAppeal(guild.id, { userId: parsed.userId, userTag, banReason, answers });
    if (appealId == null) {
      return render(res, 'pending', {
        guildName: guild.name,
        serverInvite: cfg.appealServerInvite || null,
        message: 'You already have an appeal awaiting review. Come back to this link to see the decision.',
      });
    }

    const appeal = getAppeal(guild.id, appealId);
    announceNewAppeal(guild, appeal).catch((err) =>
      log.error('appeals', 'new-appeal notice failed:', err.message)
    );
    log.info('appeals', `${parsed.userId} submitted appeal #${appealId} in ${guild.id}`);

    render(res, 'submitted', {
      guildName: guild.name,
      serverInvite: cfg.appealServerInvite || null,
      message: 'Your appeal has been submitted. Reopen this link later to see the decision.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
