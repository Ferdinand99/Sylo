// Signing in to the Sylo app (internal/mobile-api-plan.md).
//
// 1. The app opens GET /auth/mobile/start?challenge=…&state=…[&platform=…] in a browser sheet
//    (ASWebAuthenticationSession). The flow is remembered in the session and the person signs in
//    through the normal Discord / Fluxer login, which returns to /auth/mobile/confirm.
// 2. The confirmation page asks "Sign in to the Sylo app as <name>?". Allow posts back with a
//    per-flow nonce (the /auth paths are outside the global CSRF check, so the nonce is it) and
//    the server redirects to sylo://auth?code=…&state=… with a 60-second single-use code. The page
//    is what stops someone else's link from sending a code for your account to an app.
// 3. The app posts code + PKCE verifier to POST /api/mobile/token and gets an API token
//    (src/db/apiTokens.js), used as `Authorization: Bearer`. DELETE /api/mobile/token signs out.
//
// Open mode (no OAuth configured) has no accounts to hand tokens to: every route here is a 404.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../../config.js';
import { identitiesOf } from '../../db/accounts.js';
import {
  API_TOKEN_TTL_MS,
  createApiToken,
  createMobileCode,
  redeemMobileCode,
  revokeApiTokenValue,
} from '../../db/apiTokens.js';
import { enabledProviders, providers } from '../lib/oauthProviders.js';
import { bearerToken } from '../lib/bearer.js';
import { isOperator, sessionUserLabel } from '../lib/accountAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const APP_CALLBACK = 'sylo://auth';
const FLOW_TTL_MS = 10 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url of a SHA-256 (PKCE S256)
const STATE = /^[A-Za-z0-9._~-]{8,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 section 4.1

const callback = (params) => `${APP_CALLBACK}?${new URLSearchParams(params)}`;

function sameString(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** The app sign-in this session started, if it is still fresh. */
function currentFlow(req) {
  const flow = req.session?.mobile;
  if (!flow || Date.now() - flow.at > FLOW_TTL_MS) return null;
  return flow;
}

const authEnabled = (_req, res, next) => (config.authEnabled ? next() : res.status(404).end());

// --- the browser part (/auth/mobile) -------------------------------------------------------

export const mobileAuthRouter = Router();
mobileAuthRouter.use(authEnabled, rateLimit({ windowMs: 60_000, max: 30 }));

mobileAuthRouter.get('/start', (req, res) => {
  const { challenge, state, platform } = req.query;
  const provider = platform === undefined ? null : providers[platform];
  if (
    typeof challenge !== 'string' ||
    !CHALLENGE.test(challenge) ||
    typeof state !== 'string' ||
    !STATE.test(state) ||
    (platform !== undefined && !provider?.enabled())
  ) {
    return res.status(400).render('error', {
      title: 'Sign-in failed',
      heading: 'Sign-in failed',
      message: 'The Sylo app sent an invalid sign-in request. Please try again from the app.',
    });
  }
  req.session.mobile = { challenge, state, nonce: randomBytes(24).toString('base64url'), at: Date.now() };
  if (req.account) return res.redirect('/auth/mobile/confirm');
  req.session.returnTo = '/auth/mobile/confirm';
  const offered = enabledProviders();
  const login = provider ?? (offered.length === 1 ? offered[0] : null);
  res.redirect(login ? `/auth/${login.platform}/login` : '/auth/login');
});

mobileAuthRouter.get('/confirm', (req, res) => {
  const flow = currentFlow(req);
  if (!flow || !req.account) {
    return res.status(400).render('error', {
      title: 'Sign-in failed',
      heading: 'Sign-in expired',
      message:
        'This app sign-in has expired or was not started from the Sylo app. Please try again from the app.',
    });
  }
  res.render('mobile-confirm', {
    title: 'Sign in to the Sylo app',
    name: sessionUserLabel(req.account),
    platforms: req.account.identities.map((i) => providers[i.platform]?.label ?? i.platform),
    nonce: flow.nonce,
    cancelUrl: callback({ error: 'access_denied', state: flow.state }),
  });
});

mobileAuthRouter.post('/confirm', async (req, res, next) => {
  try {
    const flow = currentFlow(req);
    if (!flow || !req.account || !sameString(req.body?.nonce, flow.nonce)) {
      return res.status(403).render('error', {
        title: 'Sign-in failed',
        heading: 'Sign-in failed',
        message: 'This confirmation was not sent from the sign-in page. Please try again from the app.',
      });
    }
    req.session.mobile = undefined; // one code per flow
    const code = await createMobileCode(req.account.id, flow.challenge);
    res.redirect(callback({ code, state: flow.state }));
  } catch (err) {
    next(err);
  }
});

// --- the app part (/api/mobile) ------------------------------------------------------------

export const mobileApiRouter = Router();
mobileApiRouter.use(authEnabled);

const badGrant = (res) => res.status(400).json({ error: 'invalid_grant' });

mobileApiRouter.post('/token', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
  try {
    const { code, verifier, deviceName } = req.body ?? {};
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
      // A malformed attempt still uses up a real code, so a code cannot be probed.
      if (typeof code === 'string' && code) await redeemMobileCode(code, null);
      return badGrant(res);
    }
    const accountId = await redeemMobileCode(code, verifier);
    if (!accountId) return badGrant(res);

    const name = String(deviceName ?? '')
      .replace(/\p{Cc}/gu, '') // control characters
      .trim();
    const { token, expiresAt } = await createApiToken(accountId, {
      deviceName: name || 'Sylo app',
      ttlMs: API_TOKEN_TTL_MS,
    });
    const account = { id: accountId, identities: await identitiesOf(accountId) };
    const primary = account.identities.find((i) => i.platform === 'discord') ?? account.identities[0];
    res.json({
      token,
      expiresAt,
      account: {
        name: sessionUserLabel(account),
        avatar: primary?.avatar ?? null,
        platforms: account.identities.map((i) => i.platform),
        owner: isOperator(account),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Sign out from the app: the token it is called with stops working at once.
mobileApiRouter.delete('/token', async (req, res, next) => {
  try {
    if (!req.viaToken) return res.status(401).json({ error: 'Not signed in.' });
    await revokeApiTokenValue(bearerToken(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
