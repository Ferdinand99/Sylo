// Dashboard authentication: "Log in with Discord", gated to guild admins.
//
// Enabled when DISCORD_CLIENT_SECRET is set. Otherwise the dashboard runs in
// "open mode" — every guard passes through — which is only safe on localhost or
// a trusted LAN. A banner in the UI makes the mode obvious.
import { Router } from 'express';
import cookieSession from 'cookie-session';
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Permission bits (Discord). Admin or Manage Server, or being the owner, counts.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

function hasAdminPerms(permissionsString) {
  try {
    const p = BigInt(permissionsString ?? '0');
    return (p & PERM_ADMINISTRATOR) !== 0n || (p & PERM_MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

/** Public base URL for building the OAuth redirect URI. */
function baseUrl(req) {
  if (config.dashboardUrl) return config.dashboardUrl;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * The signed-in user for a request, or null. In open mode returns a synthetic
 * "local admin" so templates can render consistently.
 * @returns {{ id: string|null, name: string, avatar: string|null, open: boolean } | null}
 */
export function currentUser(req) {
  if (!config.authEnabled) {
    return { id: null, name: 'local admin', avatar: null, open: true };
  }
  const u = req.session?.user;
  if (!u) return null;
  return {
    id: u.id,
    name: u.global_name || u.username,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
    open: false,
  };
}

/** Guild ids (bot ∩ user-is-admin) for the signed-in user. */
export function adminGuildIds(req) {
  if (!config.authEnabled) {
    return new Set(runtime.client?.guilds.cache.keys() ?? []);
  }
  const guilds = req.session?.guilds ?? [];
  const botGuilds = new Set(runtime.client?.guilds.cache.keys() ?? []);
  return new Set(
    guilds.filter((g) => botGuilds.has(g.id) && (g.owner || hasAdminPerms(g.permissions))).map((g) => g.id)
  );
}

/** Require any signed-in user (pass-through in open mode). */
export function requireAuth(req, res, next) {
  if (!config.authEnabled || req.session?.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/discord/login');
}

/** Require the signed-in user to be an admin of req.params.guildId. */
export function requireGuildAdmin(req, res, next) {
  if (!config.authEnabled) return next();
  if (!req.session?.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }
  if (adminGuildIds(req).has(req.params.guildId)) return next();
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'Not an admin',
    message: 'You need Manage Server (or Administrator) in this server to manage it here.',
  });
}

/** Kept for backwards compatibility with earlier route code. */
export const requireAdmin = requireAuth;

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
      })
    );
  }

  // Expose auth state to every view.
  app.use((req, res, next) => {
    res.locals.authEnabled = config.authEnabled;
    res.locals.user = currentUser(req);
    next();
  });

  const router = Router();

  router.get('/discord/login', (req, res) => {
    if (!config.authEnabled) return res.redirect('/');
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    req.session.oauthState = state;
    const params = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: `${baseUrl(req)}/auth/discord/callback`,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  router.get('/discord/callback', async (req, res, next) => {
    if (!config.authEnabled) return res.redirect('/');
    try {
      const { code, state } = req.query;
      if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).render('error', {
          title: 'Login failed',
          heading: 'Login failed',
          message: 'The login response was invalid or expired. Please try again.',
        });
      }
      req.session.oauthState = undefined;

      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${baseUrl(req)}/auth/discord/callback`,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const token = await tokenRes.json();

      const headers = { Authorization: `Bearer ${token.access_token}` };
      const [user, guilds] = await Promise.all([
        fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json()),
        fetch(`${DISCORD_API}/users/@me/guilds`, { headers }).then((r) => r.json()),
      ]);

      req.session.user = {
        id: user.id,
        username: user.username,
        global_name: user.global_name,
        avatar: user.avatar,
      };
      req.session.guilds = Array.isArray(guilds)
        ? guilds.map((g) => ({ id: g.id, owner: g.owner, permissions: g.permissions }))
        : [];

      const dest = req.session.returnTo || '/';
      req.session.returnTo = undefined;
      res.redirect(dest);
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });
  // Allow GET for a plain link too.
  router.get('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  app.use('/auth', router);
}
