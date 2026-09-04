// Dashboard authentication: "Log in with Discord", gated to guild admins.
//
// Enabled when DISCORD_CLIENT_SECRET is set. Otherwise the dashboard runs in
// "open mode" — every guard passes through — which is only safe on localhost or
// a trusted LAN. A banner in the UI makes the mode obvious.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import cookieSession from 'cookie-session';
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';
import { BUILD } from '../../bot/lib/buildInfo.js';
import { buildSidebar } from '../lib/sidebarNav.js';
import { getBotMasterRoles } from '../../db/guildSettings.js';
import { rateLimit } from './rateLimit.js';

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// "Add new server" bot-invite link. Scopes + a permission set that covers every
// module: moderation (kick/ban/timeout), roles, channels & webhooks, reactions,
// invites, audit log, nickname management and voice moves for temp channels.
const BOT_INVITE_SCOPES = 'bot applications.commands';
const BOT_INVITE_PERMISSIONS = [0, 1, 2, 4, 6, 7, 10, 11, 13, 14, 15, 16, 20, 24, 27, 28, 29, 40]
  .reduce((acc, bit) => acc | (1n << BigInt(bit)), 0n)
  .toString();

/** Discord bot-invite URL for adding Sylo to another server. */
export function botInviteUrl() {
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    scope: BOT_INVITE_SCOPES,
    permissions: BOT_INVITE_PERMISSIONS,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

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

/**
 * Guilds the signed-in user can manage, resolved against the bot's cache so we
 * have names and icons. Used for the topbar server switcher.
 * @returns {Array<{ id: string, name: string, icon: string|null }>}
 */
export function manageableGuilds(req) {
  const cache = runtime.client?.guilds.cache;
  if (!cache) return [];
  return [...adminGuildIds(req)]
    .map((id) => cache.get(id))
    .filter(Boolean)
    .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 32 }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** A "bot master" — holds one of the guild's designated dashboard-admin roles. */
async function isBotMaster(guildId, userId) {
  const roles = getBotMasterRoles(guildId);
  if (!roles.length) return false;
  const guild = runtime.client?.guilds.cache.get(guildId);
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
  if (!req.session?.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }
  if (adminGuildIds(req).has(req.params.guildId)) return next();
  isBotMaster(req.params.guildId, req.session.user.id)
    .then((ok) => (ok ? next() : forbidGuild(res)))
    .catch(() => forbidGuild(res));
}

/** Kept for backwards compatibility with earlier route code. */
export const requireAdmin = requireAuth;

/** Is this user id one of the bot's operators (`OWNER_IDS`)? Always true in open mode. */
export function isOwner(userId) {
  return !config.authEnabled || config.ownerIds.includes(userId);
}

/** Render the 403 for `requireOwner` — also used directly by /health's GET route. */
export function forbidOwner(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'Not an operator',
    message: config.ownerIds.length
      ? "This page is restricted to Sylo's operators."
      : 'OWNER_IDS is not set, so no account is authorized for this page. Set it to your Discord user id.',
  });
}

/**
 * Require the signed-in user to be one of the bot's operators (`OWNER_IDS`).
 * Gates bot-wide pages — /health's status, error log and database
 * backup/restore — that must not be reachable by an arbitrary guild admin,
 * let alone any signed-in user.
 */
export function requireOwner(req, res, next) {
  if (!config.authEnabled) return next();
  if (!req.session?.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }
  if (isOwner(req.session.user.id)) return next();
  forbidOwner(res);
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
  }

  // Expose auth state to every view.
  app.use((req, res, next) => {
    res.locals.authEnabled = config.authEnabled;
    res.locals.syloVersion = BUILD.version;
    res.locals.botInviteUrl = botInviteUrl();
    // The bot's own avatar, used as the dashboard favicon (null until ready).
    res.locals.botAvatarUrl = runtime.client?.user?.displayAvatarURL({ extension: 'png', size: 64 }) ?? null;
    res.locals.user = currentUser(req);
    const mg = res.locals.user ? manageableGuilds(req) : [];
    res.locals.manageableGuilds = mg;

    const urlGuildId = (req.path.match(/^\/guilds\/(\d{17,20})/) || [])[1] || null;
    res.locals.currentGuildId = urlGuildId;

    // A server is always "in view": URL guild, else the remembered one, else the
    // first manageable one. Keeps the sidebar stable across bot-wide pages.
    const remembered = req.session?.lastGuild;
    res.locals.activeGuildId =
      urlGuildId || (mg.some((g) => g.id === remembered) ? remembered : null) || mg[0]?.id || null;
    res.locals.sidebar = buildSidebar(req, res.locals.activeGuildId);
    next();
  });

  const router = Router();

  // Throttle the OAuth endpoints (state-token guessing / callback hammering).
  router.use('/discord', rateLimit({ windowMs: 60_000, max: 20 }));

  router.get('/discord/login', (req, res) => {
    if (!config.authEnabled) return res.redirect('/');
    const state = randomUUID();
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
