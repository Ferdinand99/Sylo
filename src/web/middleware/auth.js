// Dashboard authentication: "Log in with Discord" and/or "Log in with Fluxer", gated
// to guild admins.
//
// Enabled when a platform's OAuth secret is set (DISCORD_CLIENT_SECRET /
// FLUXER_CLIENT_SECRET). Otherwise the dashboard runs in "open mode" — every guard
// passes through — which is only safe on localhost or a trusted LAN. A banner in the
// UI makes the mode obvious.
//
// Signing in resolves to an account (src/db/accounts.js) that can hold one identity per
// platform. The cookie carries only a session id; who the account is, and which guilds
// it administers, is read from the account's identities on every request.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import cookieSession from 'cookie-session';
import { config } from '../../config.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import {
  allGuildKeys,
  guildByKey,
  guildKey,
  platformOfGuild,
  primaryClient,
} from '../../platform/platformOf.js';
import { BUILD } from '../../bot/lib/buildInfo.js';
import { buildSidebar } from '../lib/sidebarNav.js';
import { getBotMasterRoles } from '../../db/guildSettings.js';
import { getAnnouncement } from '../../db/appSettings.js';
import {
  IdentityLinkedError,
  PlatformAlreadyLinkedError,
  createSession,
  deleteSession,
  getSession,
  identitiesOf,
  linkIdentity,
  purgeExpiredSessions,
  signInIdentity,
} from '../../db/accounts.js';
import { enabledProviders, fluxerOrigins, providers, adminGuildIdsFromOAuth } from '../lib/oauthProviders.js';
import { buildBotInvites } from '../lib/botInvites.js';
import {
  adminKeysOf,
  identityFor,
  isOperator,
  primaryUserId,
  sessionUserLabel,
  staleIdentities,
} from '../lib/accountAuth.js';
import { rateLimit } from './rateLimit.js';
import { log } from '../../lib/log.js';

export { adminGuildIdsFromOAuth };

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/**
 * `returnTo` is always set from `req.originalUrl` — attacker-controlled in a
 * crafted request (e.g. a path of `//evil.com/x`, which `res.redirect()`
 * sends as-is and browsers resolve as protocol-relative to another host).
 * Only redirect to a same-origin relative path: exactly one leading slash,
 * never `//` or `/\` (both browser-recognized ways to smuggle a host in).
 */
function safeReturnTo(path) {
  if (typeof path !== 'string') return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}

// An identity's guild list is a snapshot from login, not live — a server added or left
// after that point won't show up until it is refreshed. Past this age, a guild-list
// page transparently round-trips through the platform's OAuth again instead of waiting
// for the user to notice and log out/in themselves.
const GUILDS_TTL_MS = 10 * 60 * 1000;

/** "Add new server" links, one per platform Sylo runs on. */
export function botInviteUrls() {
  return buildBotInvites({
    discordClientId: config.discordClientId,
    fluxerClientId: config.fluxerClientId,
    fluxerWeb: fluxerOrigins().web,
  });
}

/** Public base URL for building the OAuth redirect URI. */
function baseUrl(req) {
  if (config.dashboardUrl) return config.dashboardUrl;
  return `${req.protocol}://${req.get('host')}`;
}

// --- who is signed in --------------------------------------------------------------

/**
 * The signed-in user for a request, or null. In open mode returns a synthetic
 * "local admin" so templates can render consistently.
 * @returns {{ id: string|null, name: string, avatar: string|null, open: boolean, platforms: string[] } | null}
 */
export function currentUser(req) {
  if (!config.authEnabled) {
    return { id: null, name: 'local admin', avatar: null, open: true, platforms: [] };
  }
  const account = req.account;
  if (!account || !account.identities.length) return null;
  const primary = account.identities.find((i) => i.platform === 'discord') ?? account.identities[0];
  return {
    id: primaryUserId(account),
    name: sessionUserLabel(account),
    avatar: primary.avatar,
    open: false,
    platforms: account.identities.map((i) => i.platform),
  };
}

/** The id other features key the signed-in person on (roadmap votes, preferences), or null. */
export function sessionUserId(req) {
  return req.account ? primaryUserId(req.account) : null;
}

/** The signed-in person's user id on the platform a guild key belongs to, or null. */
export function userIdForGuild(req, key) {
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  return identityFor(req.account, platform)?.platformUserId ?? null;
}

/**
 * Who a dashboard action in this guild is attributed to: the signed-in person's id on the
 * guild's own platform (a Discord id for a Discord server, their Fluxer id for a Fluxer
 * one), or `fallback` in open mode / when they have no identity there.
 */
export function actingUserId(req, key, fallback = 'web') {
  return userIdForGuild(req, key) ?? fallback;
}

/**
 * Guild keys the signed-in user can manage: the guilds each of their identities
 * administers, limited to the guilds the bot is in. Open mode: every guild.
 */
export function adminGuildIds(req) {
  const botKeys = allGuildKeys();
  if (!config.authEnabled) return new Set(botKeys);
  return adminKeysOf(req.account, botKeys);
}

/**
 * Guilds the signed-in user can manage, resolved against the bots' caches so we
 * have names and icons. Used for the topbar server switcher.
 * @returns {Array<{ id: string, name: string, icon: string|null, platform: 'discord'|'fluxer' }>}
 */
export function manageableGuilds(req) {
  return [...adminGuildIds(req)]
    .map((key) => guildByKey(key))
    .filter(Boolean)
    .map((g) => ({
      id: guildKey(g),
      name: g.name,
      icon: g.iconURL({ size: 32 }),
      platform: platformOfGuild(g),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- login redirects -----------------------------------------------------------------

/** Where an unauthenticated browser should go: straight to the only provider, else the chooser. */
function loginPath() {
  const enabled = enabledProviders();
  return enabled.length === 1 ? `/auth/${enabled[0].platform}/login` : '/auth/login';
}

/**
 * Send the browser somewhere that may be cross-origin (a platform's authorize page). An
 * hx-boost navigation fetches with `fetch()`, which silently fails on a cross-origin
 * redirect (the authorize page sends no CORS headers) — so a boosted request gets an
 * `HX-Redirect` response instead, which htmx turns into a real top-level
 * `window.location` navigation rather than an AJAX swap.
 */
function redirectTo(req, res, path) {
  if (req.get('HX-Request')) {
    res.set('HX-Redirect', path).status(204).end();
  } else {
    res.redirect(path);
  }
}
const redirectToLogin = (req, res) => redirectTo(req, res, loginPath());

/** Require any signed-in user (pass-through in open mode). */
export function requireAuth(req, res, next) {
  if (!config.authEnabled || req.account) return next();
  req.session.returnTo = req.originalUrl;
  redirectToLogin(req, res);
}

/** A "bot master" — holds one of the guild's designated dashboard-admin roles. */
async function isBotMaster(key, userId) {
  if (!userId) return false;
  const roles = await getBotMasterRoles(key);
  if (!roles.length) return false;
  const guild = guildByKey(key);
  if (!guild) return false;
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  return Boolean(member && member.roles.cache.hasAny(...roles));
}

function forbidGuild(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'Not an admin',
    message: 'You need Manage Server (or a bot-master role) in this server to manage it here.',
  });
}

/** Require the signed-in user to be an admin (or bot master) of req.params.guildId. */
export function requireGuildAdmin(req, res, next) {
  if (!config.authEnabled) return next();
  if (!req.account) {
    req.session.returnTo = req.originalUrl;
    return redirectToLogin(req, res);
  }
  const key = req.params.guildId;
  if (adminGuildIds(req).has(key)) return next();
  isBotMaster(key, userIdForGuild(req, key))
    .then((ok) => (ok ? next() : forbidGuild(res)))
    .catch(() => forbidGuild(res));
}

/** Kept for backwards compatibility with earlier route code. */
export const requireAdmin = requireAuth;

/** Is the signed-in account one of the bot's operators (OWNER_IDS / FLUXER_OWNER_IDS)? Always true in open mode. */
export function isOwner(req) {
  return !config.authEnabled || isOperator(req.account);
}

/** Render the 403 for `requireOwner` — also used directly by /health's GET route. */
export function forbidOwner(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'Not an operator',
    message:
      config.ownerIds.length || config.fluxerOwnerIds.length
        ? "This page is restricted to Sylo's operators."
        : 'OWNER_IDS (or FLUXER_OWNER_IDS) is not set, so no account is authorized for this page. Set it to your user id.',
  });
}

/**
 * Require the signed-in user to be one of the bot's operators. Gates bot-wide pages —
 * /health's status, error log and database backup/restore — that must not be reachable by
 * an arbitrary guild admin, let alone any signed-in user.
 */
export function requireOwner(req, res, next) {
  if (!config.authEnabled) return next();
  if (!req.account) {
    req.session.returnTo = req.originalUrl;
    return redirectToLogin(req, res);
  }
  if (isOwner(req)) return next();
  forbidOwner(res);
}

/**
 * Require a real, non-synthetic signed-in user — stricter than requireAuth, which passes
 * through unconditionally in open mode (no OAuth secret set, self-hosted default). For
 * actions that attribute authorship to a specific account (e.g. a roadmap vote or
 * suggestion) where there's no real per-user identity to attach in open mode.
 */
export function requireRealUser(req, res, next) {
  if (req.account) return next();
  res
    .status(400)
    .type('text/plain')
    .send('This action needs a real login — not available in open/self-hosted mode.');
}

// --- sessions and the OAuth routes -------------------------------------------------

/** Resolve the session cookie to an account for this request. */
async function attachAccount(req, _res, next) {
  try {
    const sid = req.session?.sid;
    if (sid) {
      const session = await getSession(sid);
      if (session) {
        req.account = { id: session.accountId, identities: await identitiesOf(session.accountId) };
      } else {
        req.session.sid = undefined; // expired or unknown
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

const redirectUri = (req, provider) => `${baseUrl(req)}${provider.callbackPath}`;

function loginError(res, message, status = 400) {
  return res.status(status).render('error', { title: 'Login failed', heading: 'Login failed', message });
}

/** Start an OAuth round-trip. `connect` adds the identity to the signed-in account instead of signing in. */
function beginOAuth(req, res, provider, { connect }) {
  if (!provider.enabled()) return res.redirect('/');
  const state = randomUUID();
  req.session.oauthState = state;
  req.session.oauthPlatform = provider.platform;
  req.session.connect = connect ? provider.platform : undefined;
  // Connecting is started from the account page, so that is where it should end.
  if (connect) req.session.returnTo = '/account?msg=connected';
  res.redirect(provider.authorizeUrl(redirectUri(req, provider), state));
}

/** Finish an OAuth round-trip: sign in (or link) the identity and start a fresh session. */
async function completeOAuth(req, provider, identity) {
  const connecting = req.session.connect === provider.platform && req.account;
  let accountId;
  if (connecting) {
    await linkIdentity(req.account.id, identity);
    accountId = req.account.id;
  } else {
    ({ accountId } = await signInIdentity(identity));
  }
  // A new session id on every login, so a fixated pre-login id is never promoted.
  if (req.session.sid) await deleteSession(req.session.sid).catch(() => {});
  req.session.sid = await createSession(accountId, SESSION_MAX_AGE);
  req.session.oauthPlatform = undefined;
  req.session.connect = undefined;
}

/**
 * Wire session handling, res.locals for templates, and the /auth/* routes.
 * @param {import('express').Express} app
 */
export function mountAuth(app) {
  if (config.authEnabled) {
    app.use(
      cookieSession({
        name: 'sylo.sid',
        keys: [config.sessionSecret],
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        // Mark the cookie Secure when the operator has declared an HTTPS dashboard.
        secure: Boolean(config.dashboardUrl?.startsWith('https://')),
      })
    );
    app.use(attachAccount);
    // Expired sessions are dead weight; sweep them a few times a day.
    setInterval(
      () => purgeExpiredSessions().catch((err) => log.error('auth', 'session purge failed:', err.message)),
      6 * 60 * 60 * 1000
    ).unref();
  }

  // An identity with a stale guild list silently round-trips through its platform's OAuth,
  // instead of making the user log out/in themselves. Scoped to the pages that actually
  // read the guild list — not every route, so a logged-in operator clicking a public link
  // (leaderboard, verify, appeal) never sees an unexpected redirect. Rate-limited because
  // it runs ahead of every other limiter in the chain.
  app.use(rateLimit({ windowMs: 60_000, max: 120 }));
  app.use((req, res, next) => {
    if (
      config.authEnabled &&
      req.method === 'GET' &&
      req.account &&
      (req.path === '/' || req.path.startsWith('/guilds'))
    ) {
      const stale = staleIdentities(req.account, GUILDS_TTL_MS).find((i) => providers[i.platform]?.enabled());
      if (stale) {
        req.session.returnTo = req.originalUrl;
        return redirectTo(req, res, `/auth/${stale.platform}/login`);
      }
    }
    next();
  });

  // Expose auth state to every view. Express 5 forwards a rejected promise
  // from an async middleware to the error handler automatically, so this
  // doesn't need an asyncHandler wrapper the way route handlers do.
  app.use(async (req, res, next) => {
    res.locals.authEnabled = config.authEnabled;
    res.locals.syloVersion = BUILD.version;
    res.locals.botInvites = botInviteUrls();
    // The bot's own avatar, used as the dashboard favicon (null until ready).
    res.locals.botAvatarUrl = primaryClient()?.user?.displayAvatarURL({ extension: 'png', size: 64 }) ?? null;
    res.locals.user = currentUser(req);
    const mg = res.locals.user ? manageableGuilds(req) : [];
    res.locals.manageableGuilds = mg;

    const urlGuildId =
      (decodeURIComponent(req.path).match(/^\/guilds\/((?:fluxer:)?\d{17,20})/) || [])[1] || null;
    res.locals.currentGuildId = urlGuildId;

    // A server is always "in view": URL guild, else the remembered one, else the
    // first manageable one. Keeps the sidebar stable across bot-wide pages.
    const remembered = req.session?.lastGuild;
    res.locals.activeGuildId =
      urlGuildId || (mg.some((g) => g.id === remembered) ? remembered : null) || mg[0]?.id || null;
    res.locals.sidebar = await buildSidebar(req, res.locals.activeGuildId);
    res.locals.announcement = res.locals.user ? await getAnnouncement() : null;
    next();
  });

  const router = Router();

  // Throttle the OAuth endpoints (state-token guessing / callback hammering). Passed to
  // each route rather than mounted on a path so every handler visibly carries its limit.
  // One bucket per platform (login, callback and connect share it), as before.
  const oauthLimit = rateLimit({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => `oauth:${req.params.platform ?? req.path.split('/')[1]}|${req.ip}`,
  });
  const pageLimit = rateLimit({ windowMs: 60_000, max: 60 });

  // The chooser, shown when more than one login is offered.
  router.get('/login', pageLimit, (req, res) => {
    if (!config.authEnabled || req.account) return res.redirect('/');
    const offered = enabledProviders();
    if (offered.length === 1) return res.redirect(`/auth/${offered[0].platform}/login`);
    res.render('login', {
      title: 'Sign in',
      providers: offered.map((p) => ({
        platform: p.platform,
        label: p.label,
        href: `/auth/${p.platform}/login`,
      })),
    });
  });

  for (const provider of Object.values(providers)) {
    router.get(`/${provider.platform}/login`, oauthLimit, (req, res) => {
      if (!config.authEnabled) return res.redirect('/');
      beginOAuth(req, res, provider, { connect: false });
    });

    router.get(`/${provider.platform}/callback`, oauthLimit, async (req, res, next) => {
      if (!config.authEnabled || !provider.enabled()) return res.redirect('/');
      try {
        const { code, state, error } = req.query;
        const expected = req.session.oauthState;
        const startedOn = req.session.oauthPlatform;
        req.session.oauthState = undefined;
        if (error || !code || !state || state !== expected || startedOn !== provider.platform) {
          return loginError(
            res,
            error === 'access_denied'
              ? `Login was cancelled on ${provider.label}.`
              : 'The login response was invalid or expired. Please try again.'
          );
        }

        const accessToken = await provider.exchange(String(code), redirectUri(req, provider));
        const identity = await provider.fetchIdentity(accessToken);
        try {
          await completeOAuth(req, provider, identity);
        } catch (err) {
          if (err instanceof IdentityLinkedError || err instanceof PlatformAlreadyLinkedError) {
            return loginError(res, err.message, 409);
          }
          throw err;
        }

        const dest = safeReturnTo(req.session.returnTo);
        req.session.returnTo = undefined;
        res.redirect(dest);
      } catch (err) {
        log.error('auth', `${provider.label} login failed:`, err.message);
        next(err);
      }
    });
  }

  // "Connect Fluxer / Discord" while signed in: links a second identity to this account.
  router.get('/connect/:platform', oauthLimit, (req, res) => {
    const provider = providers[req.params.platform];
    if (!config.authEnabled || !req.account || !provider) return res.redirect('/');
    beginOAuth(req, res, provider, { connect: true });
  });

  const logout = async (req, res) => {
    if (req.session?.sid) await deleteSession(req.session.sid).catch(() => {});
    req.session = null;
    res.redirect('/');
  };
  router.post('/logout', pageLimit, logout);
  // Allow GET for a plain link too.
  router.get('/logout', pageLimit, logout);

  app.use('/auth', router);
}
