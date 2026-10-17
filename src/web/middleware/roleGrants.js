// Dashboard saves may only make the bot hand out roles the person could hand out on the
// platform itself.
//
// Many modules make the bot give roles: autoroles, reaction roles, role buttons and menus,
// leveling rewards, verification, the birthday role, auto-react and custom-command actions.
// The bot does that with its own permissions, so without this check anyone who may use the
// dashboard (Manage Server, or a bot-master role) could set up a role above their own, or an
// Administrator role, and then give it to themselves. The rule mirrors Discord and Fluxer: a
// role must rank below the person's highest role, and a role with elevated permissions needs
// Manage Roles too. The server owner and Administrators may use any role.
//
// The check runs where the settings are written (src/db/modules.js, src/db/composedMessages.js):
// for the module being saved, the roles it hands out after the save are compared with the
// roles it handed out before, and only the new ones are checked. Roles that are only pinged,
// exempted or allowed in (ticket staff, automod immunity, alert pings …) are not grants and are
// never checked. Who is saving comes from the request, through AsyncLocalStorage: writes the
// bot makes on its own (no request) are not checked.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config.js';
import { setModuleConfigGuard } from '../../db/modules.js';
import { setComposedSpecGuard } from '../../db/composedMessages.js';
import { userIdForGuild } from './auth.js';

const actors = new AsyncLocalStorage();

// Permissions that make a role a privilege rather than a label: handing one of these out
// needs Manage Roles, as it would on the platform.
const ELEVATED = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'ManageMessages',
  'ManageNicknames',
  'ManageThreads',
  'ManageEvents',
  'ManageGuildExpressions',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'MentionEveryone',
  'MoveMembers',
  'MuteMembers',
  'DeafenMembers',
  'ViewAuditLog',
];

export class RoleGrantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoleGrantError';
    this.status = 403;
  }
}

const ids = (list) => (Array.isArray(list) ? list.map(String) : []);

/** The roles a saved message's role buttons and role menus hand out. */
export function specGrants(spec) {
  const out = [];
  for (const row of Array.isArray(spec?.rows) ? spec.rows : []) {
    for (const b of Array.isArray(row?.buttons) ? row.buttons : []) if (b?.roleId) out.push(String(b.roleId));
    for (const o of Array.isArray(row?.options) ? row.options : []) if (o?.roleId) out.push(String(o.roleId));
  }
  return out;
}

/** The roles a module's settings make the bot hand out to members. */
export function moduleGrants(moduleId, cfg = {}) {
  switch (moduleId) {
    case 'roles':
    case 'welcome':
      return [
        ...ids(cfg.autoroles),
        ...(Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : []).flatMap((m) =>
          (Array.isArray(m?.pairs) ? m.pairs : []).map((p) => String(p?.roleId ?? ''))
        ),
      ];
    case 'leveling':
      return (Array.isArray(cfg.rewards) ? cfg.rewards : []).map((r) => String(r?.roleId ?? ''));
    case 'verification':
      return [String(cfg.verifiedRoleId ?? '')];
    case 'birthdays':
      return [String(cfg.roleId ?? '')];
    case 'auto-react':
      return (Array.isArray(cfg.rules) ? cfg.rules : [])
        .filter((r) => r?.roleAction !== 'remove')
        .map((r) => String(r?.roleId ?? ''));
    case 'custom-commands':
      return (Array.isArray(cfg.commands) ? cfg.commands : []).flatMap((c) =>
        (Array.isArray(c?.actions) ? c.actions : [])
          .filter((a) => a?.type === 'add-role')
          .map((a) => String(a.roleId ?? ''))
      );
    default:
      return [];
  }
}

const hasPerm = (subject, perm) => {
  try {
    return Boolean(subject?.permissions?.has?.(perm));
  } catch {
    return false; // an unknown permission name on this platform
  }
};

/**
 * Why `member` may not hand out `role`, or null when they may.
 * @returns {string|null}
 */
export function grantRefusal(guild, member, role) {
  if (!member) return `You are not a member of this server, so you can't hand out ${role.name}.`;
  if (member.id === guild.ownerId || hasPerm(member, 'Administrator')) return null;
  const top = member.roles?.highest;
  if (!top || (role.position ?? 0) >= (top.position ?? 0)) {
    return `${role.name} is above or equal to your highest role, so you can't hand it out.`;
  }
  if (!hasPerm(member, 'ManageRoles') && ELEVATED.some((p) => hasPerm(role, p))) {
    return `${role.name} has moderator or admin permissions: you need Manage Roles to hand it out.`;
  }
  return null;
}

/** Throw a RoleGrantError when the acting person may not hand out a role new in `after`. */
async function checkNewGrants(before, after) {
  const req = actors.getStore();
  if (!req?.guild) return; // the bot's own writes
  const had = new Set(before.filter(Boolean));
  const added = [...new Set(after.filter(Boolean))].filter((id) => !had.has(id));
  const roles = added.map((id) => req.guild.roles.cache.get(id)).filter(Boolean);
  if (!roles.length) return;
  const userId = userIdForGuild(req, req.guild.id);
  const member = userId
    ? (req.guild.members.cache.get(userId) ?? (await req.guild.members.fetch(userId).catch(() => null)))
    : null;
  for (const role of roles) {
    const why = grantRefusal(req.guild, member, role);
    if (why) throw new RoleGrantError(why);
  }
}

setModuleConfigGuard(({ moduleId, prev, next }) =>
  checkNewGrants(moduleGrants(moduleId, prev), moduleGrants(moduleId, next))
);
setComposedSpecGuard(({ prev, next }) => checkNewGrants(specGrants(prev), specGrants(next)));

/**
 * Remember who is saving, for the write guards above. Mounted after the admin check on the
 * guild routers; open mode (no login) has no one to check.
 * @type {import('express').RequestHandler}
 */
export function guardRoleGrants(req, res, next) {
  if (!config.authEnabled || req.method === 'GET' || req.method === 'HEAD') return next();
  actors.run(req, next);
}
