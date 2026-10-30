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
// Before any of that, GET /api/mobile/info tells the app whether an address it was given is a
// Sylo, whether it can sign in there and what this version's app API supports.
//
// Signed in, the app turns on push notifications for tickets with /api/mobile/push
// (internal/push-notifications-plan.md, src/lib/push.js). With Postal Pigeon the notification
// has no text: the app asks GET /api/mobile/push/events/:ref for it.
//
// Open mode (no OAuth configured) has no accounts to hand tokens to: every route here but
// /api/mobile/info is a 404.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../../config.js';
import { BUILD } from '../../bot/lib/buildInfo.js';
import { identitiesOf } from '../../db/accounts.js';
import {
  API_TOKEN_TTL_MS,
  createApiToken,
  cleanDeviceName,
  createMobileCode,
  redeemMobileCode,
  revokeApiTokenValue,
  apiTokenPush,
  setApiTokenPushMuted,
  DEV_LOG_LEVELS,
  setApiTokenDevLog,
} from '../../db/apiTokens.js';
import { findPushEvent } from '../../db/pushEvents.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import {
  PushError,
  canPush,
  pigeonUrl,
  pushMode,
  pushRelayUrl,
  registerDevice,
  unregisterDevice,
} from '../../lib/push.js';
import { enabledProviders, providers } from '../lib/oauthProviders.js';
import { bearerToken } from '../lib/bearer.js';
import { isOperator, sessionUserLabel } from '../lib/accountAuth.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';
import { accountMaySeeTickets } from '../middleware/ticketAccess.js';

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

/**
 * When this browser has just finished an app sign-in: the browser could not open the app (no app
 * installed for sylo://) or the person pressed Allow twice. Say so instead of "failed".
 */
function finishedRecently(req, res) {
  const at = req.session?.mobileDone;
  if (!at || Date.now() - at > FLOW_TTL_MS) return false;
  res.status(409).render('error', {
    title: 'Already signed in',
    heading: 'Sign-in already complete',
    message:
      'This sign-in is already complete. Go back to the Sylo app. If the app did not open, start the sign-in again from the app.',
  });
  return true;
}

const authEnabled = (_req, res, next) => (config.authEnabled ? next() : res.status(404).end());

// --- the browser part (/auth/mobile) -------------------------------------------------------

export const mobileAuthRouter = Router();
// These pages hand out sign-ins: never inside someone else's frame (clickjacking on "Allow").
// First, so every answer carries it, a rate-limited one too. (The Content-Security-Policy, with
// frame-ancestors 'none', is the app-wide one from lib/securityHeaders.js: setting a narrower one
// here would replace it.)
mobileAuthRouter.use((_req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  next();
});
mobileAuthRouter.use(authEnabled, rateLimit({ windowMs: 60_000, max: 30 }));

mobileAuthRouter.get('/start', (req, res) => {
  const { challenge, state, platform } = req.query;
  // Object.hasOwn: `constructor` or `__proto__` must not resolve to an inherited property.
  const provider =
    typeof platform === 'string' && Object.hasOwn(providers, platform) ? providers[platform] : null;
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
  req.session.mobileDone = undefined;
  if (req.account) return res.redirect('/auth/mobile/confirm');
  req.session.returnTo = '/auth/mobile/confirm';
  const offered = enabledProviders();
  const login = provider ?? (offered.length === 1 ? offered[0] : null);
  res.redirect(login ? `/auth/${login.platform}/login` : '/auth/login');
});

mobileAuthRouter.get('/confirm', (req, res) => {
  const flow = currentFlow(req);
  if (!flow && finishedRecently(req, res)) return;
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
    if (!flow && finishedRecently(req, res)) return;
    if (!flow || !req.account || !sameString(req.body?.nonce, flow.nonce)) {
      return res.status(403).render('error', {
        title: 'Sign-in failed',
        heading: 'Sign-in failed',
        message: 'This confirmation was not sent from the sign-in page. Please try again from the app.',
      });
    }
    req.session.mobile = undefined; // one code per flow
    req.session.mobileDone = Date.now();
    const code = await createMobileCode(req.account.id, flow.challenge);
    res.redirect(callback({ code, state: flow.state }));
  } catch (err) {
    next(err);
  }
});

// --- the app part (/api/mobile) ------------------------------------------------------------

export const mobileApiRouter = Router();

// What this server's app API supports, so a newer app can tell what an older Sylo lacks
// (`changelog`: GET /api/v2/changelog). `push` is added when this instance can send
// notifications the older way (APNs keys, or a relay) to signed-in apps, `push-pigeon` when it
// can through Postal Pigeon. An app that knows Pigeon uses it when it is the official one.
const FEATURES = Object.freeze(['app-login', 'live-access', 'changelog']);

// Public and ahead of the open-mode guard: the app calls it before anyone signs in, and an open-mode
// server must still say it is a Sylo, just one the app cannot sign in to. Its own rate-limit bucket,
// so looking a server up does not use up the sign-in attempts on /token.
mobileApiRouter.get(
  '/info',
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => `mobile-info|${clientKey(req)}` }),
  (_req, res) => {
    res.json({
      name: 'Sylo',
      version: BUILD.version,
      apiVersion: 1,
      login: config.authEnabled,
      loginProviders: config.authEnabled ? enabledProviders().map((p) => p.platform) : [],
      platforms: [config.discordEnabled && 'discord', config.fluxerEnabled && 'fluxer'].filter(Boolean),
      features:
        config.authEnabled && canPush()
          ? [...FEATURES, ...(pushMode() ? ['push'] : []), ...(pigeonUrl() ? ['push-pigeon'] : [])]
          : FEATURES,
      // In relay mode the app registers its device token at this relay itself and gives this
      // server only the relay token (src/lib/push.js).
      ...(config.authEnabled && pushRelayUrl() ? { pushRelay: pushRelayUrl() } : {}),
      // With Pigeon the app registers at it itself and gives this server only a handle.
      ...(config.authEnabled && pigeonUrl() ? { pigeon: pigeonUrl() } : {}),
    });
  }
);

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

    const { token, expiresAt } = await createApiToken(accountId, {
      deviceName: cleanDeviceName(deviceName) || 'Sylo app',
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

// --- push notifications (/api/mobile/push) --------------------------------------------------
// Only for app tokens: the push setup lives on the token's row, and a browser has no device to
// notify. A cookie request is refused here, which is also why these paths need no CSRF token.

const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i; // APNs device tokens are hex (32 bytes today)
const RELAY_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, from the relay
const PIGEON_HANDLE = /^hrh_[A-Za-z0-9_-]{16,128}$/; // a Postal Pigeon handle
const PUSH_REF = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url (src/lib/push.js)
const PUSH_ENVIRONMENTS = new Set(['development', 'production']);
const pushLimit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => `mobile-push|${clientKey(req)}` });

function appTokenOnly(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'Not signed in.' });
  if (!req.viaToken) return res.status(403).json({ error: 'Push notifications are for the Sylo app only.' });
  next();
}

/** The address the app reaches this server at: DASHBOARD_URL, else the host it called. */
function serverOrigin(req) {
  if (config.dashboardUrl) return config.dashboardUrl;
  try {
    return new URL(`${req.protocol}://${req.get('host')}`).origin;
  } catch {
    return null;
  }
}

mobileApiRouter.post('/push', pushLimit, appTokenOnly, async (req, res, next) => {
  try {
    const { deviceToken, relayToken, pigeonHandle, environment } = req.body ?? {};
    const mode = pushMode();
    const origin = serverOrigin(req);
    if ((!mode && !pigeonUrl()) || !origin) return res.status(503).json({ error: 'push_unavailable' });
    const bad = (error) => res.status(400).json({ error });
    if (pigeonHandle !== undefined) {
      // The app registered at Pigeon itself and gives only the handle. Without Pigeon here, say
      // what this server does take, as for the other two.
      if (!pigeonUrl()) return bad(mode === 'relay' ? 'relay_token_required' : 'device_token_required');
      if (
        deviceToken !== undefined ||
        relayToken !== undefined ||
        typeof pigeonHandle !== 'string' ||
        !PIGEON_HANDLE.test(pigeonHandle) ||
        !PUSH_ENVIRONMENTS.has(environment)
      ) {
        return bad('invalid_push_token');
      }
      await registerDevice(req.apiTokenId, { pigeonHandle, environment, origin });
    } else if (!mode) {
      // Only Pigeon here: an app that does not know it cannot be notified.
      return bad('pigeon_handle_required');
    } else if (mode === 'relay') {
      // Relay mode: the app registered at the relay itself; a device token is never taken here.
      if (deviceToken !== undefined) return bad('relay_token_required');
      if (
        typeof relayToken !== 'string' ||
        !RELAY_TOKEN.test(relayToken) ||
        !PUSH_ENVIRONMENTS.has(environment)
      ) {
        return bad('invalid_push_token');
      }
      await registerDevice(req.apiTokenId, { relayToken, environment, origin });
    } else {
      if (relayToken !== undefined) return bad('device_token_required');
      if (
        typeof deviceToken !== 'string' ||
        !DEVICE_TOKEN.test(deviceToken) ||
        !PUSH_ENVIRONMENTS.has(environment)
      ) {
        return bad('invalid_push_token');
      }
      await registerDevice(req.apiTokenId, { deviceToken: deviceToken.toLowerCase(), environment, origin });
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PushError) return res.status(503).json({ error: err.code });
    next(err);
  }
});

// The text of a notification that came through Pigeon, which carries none. Only for the app token
// the notification was made for, and only while that account may still see the ticket. An unknown,
// expired, foreign or no longer permitted reference all get the same 404, so one cannot be probed.
const eventsLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => `mobile-push-events|${req.apiTokenId ?? clientKey(req)}`,
});
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

mobileApiRouter.get('/push/events/:ref', noStore, eventsLimit, appTokenOnly, async (req, res, next) => {
  try {
    const notFound = () => res.status(404).json({ error: 'not_found' });
    if (!PUSH_REF.test(req.params.ref)) return notFound();
    const event = await findPushEvent(req.params.ref, req.apiTokenId);
    if (!event) return notFound();
    const kind = event.data?.kind;
    if (kind === 'ticket') {
      const key = event.data.guildId;
      if (!isPlatformGuildId(key) || !(await accountMaySeeTickets(req.account, key, { live: true }))) {
        return notFound();
      }
    } else if (kind === 'devlog') {
      if (!isOperator(req.account)) return notFound();
    } else {
      return notFound();
    }
    res.json(event);
  } catch (err) {
    next(err);
  }
});

mobileApiRouter.delete('/push', pushLimit, appTokenOnly, async (req, res, next) => {
  try {
    await unregisterDevice(req.apiTokenId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

mobileApiRouter.get('/push', pushLimit, appTokenOnly, async (req, res, next) => {
  try {
    const push = await apiTokenPush(req.apiTokenId);
    res.json({
      enabled: Boolean(push?.enabled && canPush()),
      mutedServers: push?.mutedServers ?? [],
      // Operators only: which of Sylo's own errors and warnings this device is notified about.
      ...(isOperator(req.account) ? { devLog: push?.devLog ?? 'errors' } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// An operator's choice of dev-log notifications on this device: 'off', 'errors' or 'warnings'
// (errors and warnings).
mobileApiRouter.put('/push/dev-log', pushLimit, appTokenOnly, async (req, res, next) => {
  try {
    if (!isOperator(req.account)) return res.status(403).json({ error: "Restricted to Sylo's operators." });
    const level = req.body?.level;
    if (!DEV_LOG_LEVELS.includes(level)) return res.status(400).json({ error: 'invalid_request' });
    await setApiTokenDevLog(req.apiTokenId, level);
    res.json({ devLog: level });
  } catch (err) {
    next(err);
  }
});

// Mute or unmute one server. Only one whose tickets this person may see: the same rule that
// decides who gets a notification.
mobileApiRouter.put('/push/servers/:guildId', pushLimit, appTokenOnly, async (req, res, next) => {
  try {
    const key = req.params.guildId;
    const muted = req.body?.muted;
    if (typeof muted !== 'boolean') return res.status(400).json({ error: 'invalid_request' });
    if (!isPlatformGuildId(key) || !(await accountMaySeeTickets(req.account, key, { live: true }))) {
      return res.status(403).json({ error: 'You cannot see the tickets of this server.' });
    }
    res.json({ mutedServers: await setApiTokenPushMuted(req.apiTokenId, key, muted) });
  } catch (err) {
    next(err);
  }
});
