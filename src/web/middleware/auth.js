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
import { allGuildKeys, guildByKey, guildKey, platformOfGuild } from '../../platform/platformOf.js';
import { BUILD } from '../../bot/lib/buildInfo.js';
import { getBotMasterRoles } from '../../db/guildSettings.js';
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
import { API_TOKEN_TTL_MS, findApiToken, purgeExpiredApiTokens, touchApiToken } from '../../db/apiTokens.js';
import { purgeStaleRelayRegistrations } from '../../db/pushRelay.js';
import { bearerToken, isTokenRequest } from '../lib/bearer.js';
import { enabledProviders, fluxerOrigins, providers, adminGuildIdsFromOAuth } from '../lib/oauthProviders.js';
import { buildBotInvites } from '../lib/botInvites.js';
import { adminKeysOf, identityFor, isOperator, primaryUserId, sessionUserLabel } from '../lib/accountAuth.js';
import { clientKey, rateLimit } from './rateLimit.js';
import { hasValidCsrfToken } from './csrf.js';
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

/**
 * The `next` of `/auth/login?next=/v2/roadmap`: where to go after signing in, for a link that
 * starts the login from a page which is open without one (the new dashboard's public pages).
 * Same rule as `returnTo`: an internal path only. Anything else gives `null` and the usual
 * destination stands.
 * @returns {string | null}
 */
export function internalNext(next) {
  if (typeof next !== 'string' || next.length > 512 || next === '/') return null;
  return safeReturnTo(next) === next ? next : null;
}

function rememberNext(req) {
  const next = internalNext(req.query.next);
  if (next) req.session.returnTo = next;
}

// An identity's guild list is a snapshot from login, kept current by the bot's own events
// (src/bot/lib/adminSnapshot.js) but not checked against the platform. Past this age, access
// to a server is checked live through the bot instead of trusting the list.
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

const redirectToLogin = (req, res) => res.redirect(loginPath());

// An app request (Authorization: Bearer) cannot follow a login redirect or read an HTML error
// page, so it gets the same answers as JSON; so does any /api/ request (the new dashboard).
const wantsJson = (req) => isTokenRequest(req) || req.originalUrl.startsWith('/api/');
const notSignedIn = (res) =>
  res.status(401).json({ error: 'Not signed in, or the token is no longer valid.' });

/** Require any signed-in user (pass-through in open mode). */
export function requireAuth(req, res, next) {
  if (!config.authEnabled || req.account) return next();
  if (wantsJson(req)) return notSignedIn(res);
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

/** How a live check looks up a member the bot has not cached: one platform API call. */
export const fetchMemberFromGuild = async (guild, userId) => guild.members.fetch(userId);

/**
 * Does this person manage the guild right now, as the bot sees it: its owner, a member with
 * Manage Server or Administrator, or a bot master? Used for app (token) requests, which cannot
 * refresh the sign-in snapshot of guilds the web dashboard relies on, so a lost right must count
 * at once. Works for Fluxer too: its members have the discord.js shape (src/platform/compat.js).
 * `fetchMember` replaces the uncached lookup (push notifications cache misses, src/lib/push.js).
 */
export async function managesGuildLive(key, userId, { fetchMember = fetchMemberFromGuild } = {}) {
  const live = await serverRightsLive(key, userId, fetchMember);
  if (!live) return false;
  if (live.right) return true;
  const roles = await getBotMasterRoles(key);
  return roles.length > 0 && Boolean(live.member.roles?.cache.hasAny(...roles));
}

/**
 * The live part of managesGuildLive without bot masters: is this person the guild's owner, or a
 * member with Manage Server or Administrator? Returns null when they are not in the guild.
 */
async function serverRightsLive(key, userId, fetchMember) {
  if (!userId) return null;
  const guild = guildByKey(key);
  if (!guild) return null;
  if (guild.ownerId === userId) return { right: true, member: null };
  const member = guild.members.cache.get(userId) ?? (await fetchMember(guild, userId).catch(() => null));
  if (!member) return null;
  const right = Boolean(member.permissions?.has('ManageGuild') || member.permissions?.has('Administrator'));
  return { right, member };
}

/**
 * Does this person own the guild or hold Manage Server (or Administrator) in it right now? The
 * live check requireGuildAdmin relies on, minus the bot-master role: for what only real server
 * managers may do, such as choosing the bot masters.
 */
export async function holdsManageServerLive(key, userId, { fetchMember = fetchMemberFromGuild } = {}) {
  return Boolean((await serverRightsLive(key, userId, fetchMember))?.right);
}

/**
 * The live check for an app (token) request. Only for a guild the person administered at sign-in,
 * or one with bot-master roles set: otherwise any signed-in token could make the bot look people
 * up in every server it is in, one Discord API call per request.
 */
export async function tokenManagesGuild(req, key) {
  return accountManagesGuildLive(req.account, key);
}

/**
 * tokenManagesGuild for an account rather than a request, so a push notification's recipients
 * (src/lib/push.js) are checked by the same rule. App tokens exist only with sign-in enabled, so
 * the sign-in snapshot is the account's own guild lists.
 * @param {{ identities: Array<{ platform: string, platformUserId: string, guildIds: string[] }> }} account
 */
export async function accountManagesGuildLive(account, key, options) {
  if (!adminKeysOf(account, allGuildKeys()).has(key) && !(await getBotMasterRoles(key)).length) return false;
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  return managesGuildLive(key, identityFor(account, platform)?.platformUserId ?? null, options);
}

/**
 * Is the account's guild list for this guild's platform recent enough to trust without a live
 * check? Past GUILDS_TTL_MS the list may hide a lost right (or a removal from the server).
 */
export function snapshotIsFresh(account, key, now = Date.now()) {
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  const identity = identityFor(account, platform);
  return Boolean(identity) && now - identity.guildsFetchedAt <= GUILDS_TTL_MS;
}

function forbidGuild(req, res) {
  if (wantsJson(req)) return res.status(403).json({ error: 'You do not manage this server.' });
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'Not an admin',
    message:
      'You need Manage Server (or a bot-master role) in this server to manage it here, and Sylo has to be in it.',
  });
}

/** Require the signed-in user to be an admin (or bot master) of req.params.guildId. */
export function requireGuildAdmin(req, res, next) {
  if (!config.authEnabled) return next();
  if (!req.account) {
    if (wantsJson(req)) return notSignedIn(res);
    req.session.returnTo = req.originalUrl;
    return redirectToLogin(req, res);
  }
  const key = req.params.guildId;
  if (req.viaToken) {
    return tokenManagesGuild(req, key)
      .then((ok) => (ok ? next() : forbidGuild(req, res)))
      .catch(() => forbidGuild(req, res));
  }
  // The sign-in snapshot is only refreshed on GET / and /guilds pages, so V2 requests and form
  // posts would trust it for the whole session. Past the refresh window, check live instead,
  // like a token: someone who lost Manage Server is refused within minutes.
  if (!snapshotIsFresh(req.account, key)) {
    return accountManagesGuildLive(req.account, key)
      .then((ok) => (ok ? next() : forbidGuild(req, res)))
      .catch(() => forbidGuild(req, res));
  }
  if (adminGuildIds(req).has(key)) return next();
  isBotMaster(key, userIdForGuild(req, key))
    .then((ok) => (ok ? next() : forbidGuild(req, res)))
    .catch(() => forbidGuild(req, res));
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
    if (wantsJson(req)) return notSignedIn(res);
    req.session.returnTo = req.originalUrl;
    return redirectToLogin(req, res);
  }
  if (isOwner(req)) return next();
  if (wantsJson(req)) return res.status(403).json({ error: "Restricted to Sylo's operators." });
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
  if (wantsJson(req)) return res.status(400).json({ error: 'This action needs a real login.' });
  res
    .status(400)
    .type('text/plain')
    .send('This action needs a real login — not available in open/self-hosted mode.');
}

// --- sessions and the OAuth routes -------------------------------------------------

/**
 * Resolve the request to an account: an app token on an /api/ path (src/web/lib/bearer.js), else
 * the session cookie. A request that presents a token is judged by the token alone, so a bad
 * token never falls back to a cookie.
 */
async function attachAccount(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (token !== null) {
      const record = await findApiToken(token);
      if (record) {
        req.account = { id: record.accountId, identities: await identitiesOf(record.accountId) };
        req.viaToken = true;
        req.apiTokenId = record.id;
        touchApiToken(record, { ttlMs: API_TOKEN_TTL_MS }).catch((err) =>
          log.error('auth', 'token touch failed:', err.message)
        );
      }
      return next();
    }
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
  if (connect) req.session.returnTo = '/v2/account';
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
  // A new CSRF token with the new session (csrf.js mints it on the next request).
  req.session.csrf = undefined;
  req.session.oauthPlatform = undefined;
  req.session.connect = undefined;
}

/**
 * Wire session handling, res.locals for the few server-rendered pages, and the /auth/* routes.
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
    // Expired sessions (and app tokens, sign-in codes and push relay registrations unused for 90
    // days) are dead weight; sweep them a few times a day.
    setInterval(
      () =>
        Promise.all([purgeExpiredSessions(), purgeExpiredApiTokens(), purgeStaleRelayRegistrations()]).catch(
          (err) => log.error('auth', 'session purge failed:', err.message)
        ),
      6 * 60 * 60 * 1000
    ).unref();
  }

  // The guild list from sign-in is not refreshed by sending the browser through the platform's
  // login again: the bot keeps it current from its own events (src/bot/lib/adminSnapshot.js),
  // and once it is older than GUILDS_TTL_MS access is checked live (requireGuildAdmin).
  // Rate-limited because the view setup below runs ahead of every other limiter in the chain.
  app.use(rateLimit({ windowMs: 60_000, max: 120 }));

  // What the few server-rendered pages (login, mobile sign-in, errors) use. No database work:
  // the dashboard reads its own data through /api/v2.
  app.use((req, res, next) => {
    res.locals.syloVersion = BUILD.version;
    next();
  });

  const router = Router();

  // Throttle the OAuth endpoints (state-token guessing / callback hammering). Passed to
  // each route rather than mounted on a path so every handler visibly carries its limit.
  // One bucket per platform (login, callback and connect share it), as before.
  const oauthLimit = rateLimit({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => `oauth:${req.params.platform ?? req.path.split('/')[1]}|${clientKey(req)}`,
  });
  const pageLimit = rateLimit({ windowMs: 60_000, max: 60 });

  // The chooser, shown when more than one login is offered.
  router.get('/login', pageLimit, (req, res) => {
    if (!config.authEnabled || req.account) return res.redirect('/');
    rememberNext(req);
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
      rememberNext(req);
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
    // /auth runs before the csrf middleware: check the token here, so another site cannot
    // sign anyone out.
    if (config.authEnabled && !hasValidCsrfToken(req)) return res.redirect('/');
    if (req.session?.sid) await deleteSession(req.session.sid).catch(() => {});
    req.session = null;
    res.redirect('/');
  };
  // POST only, with the CSRF token (csrf.js): a link on another site must not sign anyone out.
  router.post('/logout', pageLimit, logout);

  app.use('/auth', router);
}
