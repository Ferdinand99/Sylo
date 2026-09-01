// Public (no-auth) verification page: a member clicks the Verify button in
// Discord, gets a signed link here, solves a Cloudflare Turnstile captcha, and
// the bot grants the verified role.
import { Router } from 'express';
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { log } from '../../lib/log.js';
import {
  verifyVerifyToken,
  normaliseVerificationConfig,
  grantVerified,
} from '../../modules/verification.js';

const router = Router();
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function fail(res, message) {
  return res.status(400).render('verify', { state: 'error', message, siteKey: null, token: null, guildId: null });
}

router.get('/:guildId', (req, res) => {
  const { guildId } = req.params;
  const parsed = verifyVerifyToken(req.query.t);
  if (!parsed || parsed.guildId !== guildId) {
    return fail(res, 'This verification link is invalid or has expired. Click Verify again in Discord.');
  }
  if (!config.turnstileEnabled) {
    return fail(res, 'The captcha is not configured on this server. Ask an admin.');
  }
  if (!isModuleEnabled(guildId, 'verification')) {
    return fail(res, 'Verification is no longer active in that server.');
  }
  res.render('verify', {
    state: 'challenge',
    message: null,
    siteKey: config.turnstileSiteKey,
    token: req.query.t,
    guildId,
  });
});

router.post('/:guildId', async (req, res, next) => {
  try {
    const { guildId } = req.params;
    const parsed = verifyVerifyToken(req.body.t);
    if (!parsed || parsed.guildId !== guildId) {
      return fail(res, 'This verification link is invalid or has expired. Click Verify again in Discord.');
    }
    if (!config.turnstileEnabled) return fail(res, 'The captcha is not configured.');

    const cfResponse = String(req.body['cf-turnstile-response'] ?? '');
    const verifyRes = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: config.turnstileSecretKey,
        response: cfResponse,
        remoteip: req.ip,
      }),
    }).then((r) => r.json()).catch(() => ({ success: false }));

    if (!verifyRes.success) {
      log.warn('verification', `Turnstile failed for ${parsed.userId} in ${guildId}:`, verifyRes['error-codes'] ?? '');
      return fail(res, 'The captcha check failed. Go back and try again.');
    }

    const guild = runtime.client?.guilds.cache.get(guildId);
    if (!guild || !isModuleEnabled(guildId, 'verification')) {
      return fail(res, 'Verification is no longer active in that server.');
    }
    const cfg = normaliseVerificationConfig(getGuildModule(guildId, 'verification').config);
    const result = await grantVerified(guild, parsed.userId, cfg);
    log.info('verification', `web verify ${parsed.userId} in ${guildId} -> ${result}`);

    if (result === 'ok' || result === 'already') {
      if (result === 'ok') {
        // Let them know back in Discord too (the interaction token is long gone).
        guild.client.users
          .fetch(parsed.userId)
          .then((u) => u.send({ content: `${cfg.successMessage}\n*(${guild.name})*` }))
          .catch(() => {});
      }
      return res.render('verify', {
        state: 'done',
        message: result === 'already' ? 'You were already verified.' : cfg.successMessage,
        siteKey: null,
        token: null,
        guildId,
      });
    }
    return fail(res, "Couldn't grant the role — the bot may be missing Manage Roles, or its highest role is below the verified role. Tell an admin.");
  } catch (err) {
    next(err);
  }
});

export default router;
