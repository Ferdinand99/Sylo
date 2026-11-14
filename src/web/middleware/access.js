// Dashboard access levels: who may read and who may change what in a server, through the dashboard
// and the Sylo app (both use /api/v2).
//
// Three levels, each including the ones below it:
//   view   read-only
//   inbox  view, plus acting on tickets, ban appeals, applications and suggestions
//   edit   everything
// The server's owner, members with Manage Server or Administrator, and the bot-master roles always
// have edit, as they always had the whole dashboard. A server can give other roles inbox or view
// (Server settings → Dashboard access, stored in guild_settings).
//
// Two halves, kept apart so no route checks rights on its own:
//   requireGuildAccess  mounted once in front of every /guilds/:guildId route: works out the
//                       person's level in that server (req.access) and refuses someone with none.
//   accessRouter        a Router whose routes each get the guard for the level ROUTE_ACCESS
//                       (src/web/lib/routeAccess.js) gives them, or edit when it gives none.
import { Router } from 'express';
import { config } from '../../config.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { allGuildKeys, guildByKey } from '../../platform/platformOf.js';
import { getDashboardAccessRoles, guildsWithAccessRoles } from '../../db/guildSettings.js';
import { adminKeysOf, identityFor } from '../lib/accountAuth.js';
import { ROUTE_ACCESS } from '../lib/routeAccess.js';
import {
  fetchMemberFromGuild,
  requireOwner,
  serverRightsLive,
  snapshotIsFresh,
  userIdForGuild,
} from './auth.js';
import { RoleGrantError } from './roleGrants.js';

/** @typedef {'view' | 'inbox' | 'edit'} AccessLevel */

export const ACCESS_LEVELS = Object.freeze(['view', 'inbox', 'edit']);
const RANK = { view: 1, inbox: 2, edit: 3 };

/** Does `have` (a level, or null for none) reach `need`? */
export function atLeast(have, need) {
  return (RANK[have] ?? 0) >= RANK[need];
}

/** May this request do what `need` allows in the server it is about (req.access)? */
export const requestCan = (req, need) => !config.authEnabled || atLeast(req.access, need);

/**
 * May this request see what the inboxes contain (ticket messages, appeal answers, decision reasons,
 * who wrote an anonymous suggestion)? Inbox and Edit may; View sees the lists without it. Lists that
 * View may open blank those fields with this; `contentHidden` tells the client why they are empty.
 */
export const seesInboxContent = (req) => requestCan(req, 'inbox');

/** The highest level a member's roles give, or null. */
function levelFromRoles(member, roles) {
  const holds = (list) => list.length > 0 && Boolean(member?.roles?.cache?.hasAny?.(...list));
  if (holds(roles.edit)) return 'edit';
  if (holds(roles.inbox)) return 'inbox';
  if (holds(roles.view)) return 'view';
  return null;
}

const NONE = Object.freeze({ level: null, member: null });

// Without the Server Members intent (INTENT_GUILD_MEMBERS=false, Discord), the bot is not told when a
// member's roles change or they leave, so its cached member could keep a role that was taken away.
// Then the member is fetched from Discord before a role decides access: on every write, and for reads
// at most once a minute per person and server.
const REFRESH_MS = 60_000;
const refreshedAt = new Map(); // `${guild key}|${user id}` -> when

async function refreshStaleMember(key, userId, { write }) {
  if (config.intentGuildMembers || !userId) return;
  if ((splitPlatformGuildId(key)?.platform ?? 'discord') !== 'discord') return;
  const id = `${key}|${userId}`;
  const now = Date.now();
  if (!write && now - (refreshedAt.get(id) ?? 0) < REFRESH_MS) return;
  if (refreshedAt.size > 10_000) refreshedAt.clear();
  refreshedAt.set(id, now);
  const guild = guildByKey(key);
  if (!guild) return;
  try {
    await guild.members.fetch({ user: userId, force: true });
  } catch (err) {
    if (err?.code === 10007) guild.members.cache.delete(userId); // Unknown Member: they left
  }
}

/**
 * The account's level in a server, and the member the answer was read from (null when none was
 * needed), so a caller that checks more roles (ticket staff) does not look the member up twice.
 *
 * `live` is for app tokens and for a web session whose sign-in snapshot of servers is older than its
 * refresh window: Manage Server is then checked through the bot, so a lost right counts at once.
 * Live checks run only for a server the person administered at sign-in or one with access roles;
 * otherwise any signed-in token could make the bot look people up in every server it is in.
 * @returns {Promise<{ level: AccessLevel | null, member: object | null }>}
 */
export async function accountGuildAccessDetail(
  account,
  key,
  { live, fetchMember = fetchMemberFromGuild, write = false }
) {
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  const userId = identityFor(account, platform)?.platformUserId ?? null;
  const inSnapshot = adminKeysOf(account, allGuildKeys()).has(key);
  if (!live && inSnapshot) return { level: 'edit', member: null };

  const roles = await getDashboardAccessRoles(key);
  const anyRoles = roles.edit.length + roles.inbox.length + roles.view.length > 0;
  if (live) {
    if (!inSnapshot && !anyRoles) return NONE;
    await refreshStaleMember(key, userId, { write });
    const rights = await serverRightsLive(key, userId, fetchMember);
    if (!rights) return NONE;
    if (rights.right) return { level: 'edit', member: rights.member };
    return { level: levelFromRoles(rights.member, roles), member: rights.member };
  }

  // A fresh snapshot without this server: only a role can let the person in.
  if (!anyRoles || !userId) return NONE;
  await refreshStaleMember(key, userId, { write });
  const guild = guildByKey(key);
  if (!guild) return NONE;
  const member = guild.members.cache.get(userId) ?? (await fetchMember(guild, userId).catch(() => null));
  return { level: levelFromRoles(member, roles), member };
}

/** The account's level in a server, or null. See accountGuildAccessDetail. */
export async function accountGuildAccess(account, key, options) {
  return (await accountGuildAccessDetail(account, key, options)).level;
}

/** Should this request's rights in a server be checked live (see accountGuildAccessDetail)? */
export const checksLive = (req, key) => Boolean(req.viaToken) || !snapshotIsFresh(req.account, key);

/**
 * The signed-in person's level in a server: edit in open mode (no logins: everyone is the admin),
 * null when signed out or without access.
 * @returns {Promise<AccessLevel | null>}
 */
export async function requestGuildAccess(req, key) {
  if (!config.authEnabled) return 'edit';
  if (!req.account) return null;
  return accountGuildAccess(req.account, key, {
    live: checksLive(req, key),
    write: req.method !== 'GET' && req.method !== 'HEAD',
  });
}

/**
 * Does the acting person hold `permission` in this server (req.guild) on the platform? The owner and
 * Administrator hold every one. For an Inbox action that does with the bot's rights what the person
 * could otherwise not do on the platform (accepting an appeal lifts a ban). Open mode: yes.
 */
export async function actorHolds(req, permission) {
  if (!config.authEnabled) return true;
  const guild = req.guild;
  const userId = guild ? userIdForGuild(req, req.params.guildId) : null;
  if (!userId) return false;
  if (guild.ownerId === userId) return true;
  await refreshStaleMember(req.params.guildId, userId, { write: true });
  const member =
    guild.members.cache.get(userId) ?? (await fetchMemberFromGuild(guild, userId).catch(() => null));
  try {
    return Boolean(member?.permissions?.has('Administrator') || member?.permissions?.has(permission));
  } catch {
    return false; // a permission this platform does not know
  }
}

const LEVEL_WORD = { view: 'View', inbox: 'Inbox', edit: 'Edit' };

/**
 * Throw a RoleGrantError (403) when one of `roleIds` gives dashboard access above the acting person's
 * own level in this server: an Inbox user handing out an Edit (bot-master) role through an application,
 * say. The platform's own rule (roleGrants.js) only compares positions and permissions; this closes
 * the step from Inbox to Edit even when the person outranks the role on the platform.
 */
export async function checkAccessRoleGrants(req, roleIds) {
  if (!config.authEnabled || !roleIds.length) return;
  const roles = await getDashboardAccessRoles(req.params.guildId);
  for (const id of roleIds) {
    const gives = roles.edit.includes(id)
      ? 'edit'
      : roles.inbox.includes(id)
        ? 'inbox'
        : roles.view.includes(id)
          ? 'view'
          : null;
    if (gives && !atLeast(req.access, gives)) {
      const name = req.guild?.roles?.cache?.get?.(id)?.name ?? id;
      throw new RoleGrantError(
        `${name} gives ${LEVEL_WORD[gives]} access to the dashboard, more than yours, so you can't hand it out.`
      );
    }
  }
}

const notSignedIn = (res) =>
  res.status(401).json({ error: 'Not signed in, or the token is no longer valid.' });
const noAccess = (res) => res.status(403).json({ error: 'You do not manage this server.' });

/**
 * In front of every /guilds/:guildId route: sets req.access to the person's level in that server,
 * and answers 403 when they have none. The level each route needs is checked by accessRouter.
 * @type {import('express').RequestHandler}
 */
export const requireGuildAccess = useMiddleware(function requireGuildAccess(req, res, next) {
  if (!config.authEnabled) {
    req.access = 'edit';
    return next();
  }
  if (!req.account) return notSignedIn(res);
  requestGuildAccess(req, req.params.guildId)
    .then((level) => {
      if (!level) return noAccess(res);
      req.access = level;
      next();
    })
    .catch(() => noAccess(res));
});

const LEVEL_NAME = { view: 'View only', inbox: 'Inbox only' };

/** The guard for a route that needs `need`. Refuses when req.access was never set: fail closed. */
function levelGuard(need) {
  const guard = (req, res, next) => {
    if (!config.authEnabled || atLeast(req.access, need)) return next();
    if (!req.access) return noAccess(res);
    res.status(403).json({
      error: `Your dashboard access in this server is ${LEVEL_NAME[req.access]}, so you can't do this.`,
      access: req.access,
      required: need,
    });
  };
  guard.accessLevel = need;
  return guard;
}

/** For a route that keeps the guard it has (self, member, public, operator). */
function passThrough(level) {
  const guard = (_req, _res, next) => next();
  guard.accessLevel = level;
  return guard;
}

// Every route an accessRouter registered, with the level it got from ROUTE_ACCESS (null: not listed,
// so it needs edit). Read by the test that every route is listed.
const registered = new Map();

/** Routes registered without an entry in ROUTE_ACCESS (they need edit). */
export const undeclaredRoutes = () => [...registered].filter(([, level]) => level === null).map(([k]) => k);
/** ROUTE_ACCESS entries no route was registered for: a renamed or removed route. */
export const unusedDeclarations = () => Object.keys(ROUTE_ACCESS).filter((k) => !registered.has(k));
/** Every registered route and its level. */
export const registeredRoutes = () => new Map(registered);

const SERVER_LEVELS = new Set(ACCESS_LEVELS);
const OTHER_LEVELS = new Set(['self', 'operator', 'member', 'public']);

function guardFor(key, level, handlers) {
  const path = key.slice(key.indexOf(' ') + 1);
  const perServer = path.startsWith('/guilds/:guildId');
  if (level === undefined) return levelGuard('edit');
  if (SERVER_LEVELS.has(level)) {
    if (!perServer) throw new Error(`${key}: "${level}" is for /guilds/:guildId routes only`);
    return levelGuard(level);
  }
  if (!OTHER_LEVELS.has(level)) throw new Error(`${key}: unknown access level "${level}"`);
  if (perServer)
    throw new Error(`${key}: a /guilds/:guildId route needs view, inbox or edit, not "${level}"`);
  if (level === 'operator' && !handlers.includes(requireOwner)) {
    throw new Error(`${key}: an operator route must carry requireOwner`);
  }
  return passThrough(level);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Mark a handler that may be mounted with router.use on an access router: one that only prepares a
 * request or refuses it (sets req.access, loads req.guild, answers 404), never one that does what a
 * route does. Anything mounted with use runs without a route's level guard, so nothing else may be.
 */
export function useMiddleware(fn) {
  fn.accessMiddleware = true;
  return fn;
}

/**
 * A Router whose routes each start with the guard for their access level. `prefix` is where the
 * router is mounted under /api/v2 ('' for the main router, '/guilds/:guildId' for a per-server one),
 * so a route's key in ROUTE_ACCESS is its full path. Paths must be strings, and router.all /
 * router.route are not offered: each method and path has its own entry.
 * @param {string} prefix
 * @param {import('express').RouterOptions} [options]
 */
export function accessRouter(prefix, options) {
  const router = Router(options);
  // router.get(path, …) is router.route(path).get(…) underneath; the route() kept here is the real
  // one, the instance's own is replaced below.
  const route = router.route.bind(router);
  for (const method of METHODS) {
    router[method] = (path, ...handlers) => {
      if (typeof path !== 'string') {
        throw new Error(`${method.toUpperCase()} on ${prefix || '/'}: the path must be a string`);
      }
      const full = path === '/' ? prefix || '/' : `${prefix}${path}`;
      const key = `${method.toUpperCase()} ${full}`;
      if (registered.has(key)) throw new Error(`${key} is registered twice`);
      const level = Object.hasOwn(ROUTE_ACCESS, key) ? ROUTE_ACCESS[key] : undefined;
      registered.set(key, level ?? null);
      route(path)[method](guardFor(key, level, handlers), ...handlers);
      return router;
    };
  }
  // router.use takes routers (themselves access routers, which the tree test checks) and handlers
  // marked with useMiddleware; anything else would answer without a level guard.
  const use = router.use.bind(router);
  router.use = (...args) => {
    for (const handler of args.flat(Infinity)) {
      if (typeof handler !== 'function' || Array.isArray(handler.stack) || handler.accessMiddleware) continue;
      throw new Error(
        `router.use on ${prefix || '/'}: mount routers or useMiddleware() handlers only (${handler.name || 'anonymous'})`
      );
    }
    return use(...args);
  };
  for (const name of ['all', 'route']) {
    router[name] = () => {
      throw new Error(`router.${name} is not available on an access router: register each method`);
    };
  }
  return router;
}

/**
 * Servers the person reaches only through an access role (bot-master, Inbox or View), as the bot's
 * member cache sees them: no platform call, so a member the bot has not cached is not listed (they
 * still get in through a link, checked as usual). Excludes the servers in `known`.
 * @returns {Promise<string[]>} guild keys
 */
export async function roleAccessGuildKeys(account, known = new Set()) {
  if (!config.authEnabled || !account) return [];
  const out = [];
  for (const [key, roles] of await guildsWithAccessRoles()) {
    if (known.has(key)) continue;
    const guild = guildByKey(key);
    if (!guild) continue;
    const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
    const userId = identityFor(account, platform)?.platformUserId;
    const member = userId ? guild.members.cache.get(userId) : null;
    if (member?.roles?.cache?.hasAny?.(...roles)) out.push(key);
  }
  return out;
}
