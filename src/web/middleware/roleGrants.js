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
// for the module being saved, the grants it makes after the save (a role and the place that
// decides who receives it) are compared with the grants it made before, and only the new or
// changed ones are checked. Switching a module on checks every grant it holds. Roles that are only pinged,
// exempted or allowed in (ticket staff, automod immunity, alert pings …) are not grants and are
// never checked. Who is saving comes from the request, through AsyncLocalStorage: writes the
// bot makes on its own (no request) are not checked.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config.js';
import { getGuildModule, setModuleConfigGuard } from '../../db/modules.js';
import { getMember } from '../../db/leveling.js';
import { normaliseLevelingConfig, rewardRolesToAdd } from '../../modules/leveling.js';
import { levelFromXp } from '../../modules/lib/levels.js';
import { setComposedSpecGuard } from '../../db/composedMessages.js';
import { guildKey } from '../../platform/platformOf.js';
import { raisesIncome, soldRoleIds } from '../../modules/lib/economyFunding.js';
import { getDashboardAccessRoles } from '../../db/guildSettings.js';
import { holdsManageServerLive, userIdForGuild } from './auth.js';

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

const botMasterRefusal = (role) =>
  `${role.name} gives Edit access to the dashboard: only the server owner or someone with Manage Server can hand it out.`;

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

/**
 * The places a module's settings make the bot hand out a role, as { roleId, site } entries. The
 * site is what decides who receives the role (which channel a menu sits in, which level unlocks a
 * reward, who may run a command): the same role in a new or changed place is a new grant, even
 * when the module already hands the role out somewhere else.
 */
export function moduleGrantSites(moduleId, cfg = {}) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const sorted = (v) => ids(v).sort().join(',');
  switch (moduleId) {
    case 'roles':
    case 'welcome':
      return [
        ...ids(cfg.autoroles).map((roleId) => ({ roleId, site: 'autorole' })),
        ...list(cfg.reactionMessages).flatMap((m) =>
          list(m?.pairs).map((p) => ({
            roleId: String(p?.roleId ?? ''),
            site: `rr:${m?.id ?? ''}:${m?.channelId ?? ''}:${m?.mode === 'reverse' ? 'reverse' : 'default'}`,
          }))
        ),
      ];
    case 'leveling':
      return list(cfg.rewards).map((r) => ({
        roleId: String(r?.roleId ?? ''),
        site: `level:${r?.level ?? ''}`,
      }));
    case 'verification':
      return [{ roleId: String(cfg.verifiedRoleId ?? ''), site: `verified:${cfg.channelId ?? ''}` }];
    case 'birthdays':
      return [{ roleId: String(cfg.roleId ?? ''), site: 'birthday' }];
    case 'auto-react':
      return list(cfg.rules)
        .filter((r) => r?.roleAction !== 'remove')
        .map((r) => ({
          roleId: String(r?.roleId ?? ''),
          site: `rule:${r?.id ?? ''}:${sorted(r?.targetUsers)}:${sorted(r?.targetRoles)}:${r?.channelId ?? ''}:${r?.mode === 'random' ? `random${Number(r?.chance) || 50}` : 'always'}`,
        }));
    case 'custom-commands':
      return list(cfg.commands).flatMap((c) =>
        list(c?.actions)
          .filter((a) => a?.type === 'add-role')
          .map((a) => ({
            roleId: String(a.roleId ?? ''),
            site: `cmd:${c?.id ?? c?.name ?? ''}:${sorted(c?.allowedRoles)}:${sorted(c?.allowedChannels)}`,
          }))
      );
    default:
      return [];
  }
}

/** The roles a module's settings make the bot hand out to members. */
export function moduleGrants(moduleId, cfg = {}) {
  return moduleGrantSites(moduleId, cfg).map((g) => g.roleId);
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

/**
 * Throw a RoleGrantError when the acting person may not hand out a grant new in `after`. A grant is
 * a role id, or a { roleId, site } entry where the site says who receives it: an entry whose role
 * is already handed out elsewhere is still new when its site is.
 */
async function checkNewGrants(before, after) {
  const req = actors.getStore();
  if (!req?.guild) return; // the bot's own writes
  const entry = (g) => (typeof g === 'string' ? { roleId: g, site: '' } : g);
  const keyOf = (g) => JSON.stringify([g.roleId, g.site]);
  const had = new Set(
    before
      .map(entry)
      .filter((g) => g.roleId)
      .map(keyOf)
  );
  const added = after.map(entry).filter((g) => g.roleId && !had.has(keyOf(g)));
  const roleIds = [...new Set(added.map((g) => g.roleId))];
  const roles = roleIds.map((id) => req.guild.roles.cache.get(id)).filter(Boolean);
  if (!roles.length) return;
  const userId = userIdForGuild(req, req.guild.id);
  const member = userId
    ? (req.guild.members.cache.get(userId) ?? (await req.guild.members.fetch(userId).catch(() => null)))
    : null;
  for (const role of roles) {
    const why = grantRefusal(req.guild, member, role);
    if (why) throw new RoleGrantError(why);
  }
  // A bot-master (dashboard Edit) role is a privilege too, though it carries no platform permission: only
  // those who may choose the bot masters (the owner, a live Manage Server holder) may hand one out.
  const { edit } = await getDashboardAccessRoles(guildKey(req.guild));
  const botMaster = roles.find((r) => edit.includes(r.id));
  if (botMaster && !(await holdsManageServerLive(guildKey(req.guild), userId))) {
    throw new RoleGrantError(botMasterRefusal(botMaster));
  }
}

// Settings that make Sylo ping the whole server with its own right to, and how far each choice reaches.
const PING_REACH = { giveaways: { field: 'ping', rank: { none: 0, here: 1, everyone: 2 } } };

/**
 * Making the bot ping @here or @everyone is its own right, so raising such a setting takes the server
 * owner or a live Manage Server holder, not just a bot master (the same rule as the reminders ping setting).
 * Keeping or lowering it is open to anyone who may save the module.
 */
async function checkPingRaise(moduleId, prev, next) {
  const reach = PING_REACH[moduleId];
  const req = actors.getStore();
  if (!reach || !req?.guild) return;
  const level = (cfg) => reach.rank[cfg?.[reach.field]] ?? 0;
  if (level(next) <= level(prev)) return;
  if (await holdsManageServerLive(guildKey(req.guild), userIdForGuild(req, req.guild.id))) return;
  throw new RoleGrantError(
    'Only the server owner or someone with Manage Server can make giveaways ping @here or @everyone.'
  );
}

/**
 * grantRefusal for a person deciding in the chat (the Accept and Deny buttons, a command), who has no
 * dashboard request: the same rank and permission rule, plus the one for a bot-master (Edit) role, which
 * only the owner, Administrators and Manage Server holders may hand out.
 * @returns {Promise<string|null>}
 */
export async function chatGrantRefusal(guild, member, role) {
  const why = grantRefusal(guild, member, role);
  if (why) return why;
  const { edit } = await getDashboardAccessRoles(guildKey(guild));
  const manages =
    member.id === guild.ownerId || hasPerm(member, 'Administrator') || hasPerm(member, 'ManageGuild');
  return edit.includes(role.id) && !manages ? botMasterRefusal(role) : null;
}

/** The sentence for a refusal where money would buy a role the person may not hand out. */
export const fundingRefusal = (why, what) =>
  `The shop sells a role you can't hand out, so you can't ${what} while it is on sale. ${why}`;

/**
 * For what funds a purchase of the shop's role items (a staff credit, the income settings, the starting
 * balance): throw a RoleGrantError unless the acting person could hand out every role the shop sells.
 */
export async function checkFundingGrants(guildId, what) {
  try {
    await checkRoleGrants(await soldRoleIds(guildId));
  } catch (err) {
    if (err instanceof RoleGrantError) throw new RoleGrantError(fundingRefusal(err.message, what));
    throw err;
  }
}

/**
 * The module write guard's check, for a route that must refuse before it does anything else
 * (publishing a role menu posts to the channel before the save reaches the guard).
 */
export async function checkModuleGrants(moduleId, prev, next, { switchingOn = false } = {}) {
  await checkPingRaise(moduleId, prev, next);
  if (moduleId === 'economy' && raisesIncome(prev, next, { switchingOn })) {
    const guildId = actors.getStore()?.guild ? guildKey(actors.getStore().guild) : null;
    if (guildId) await checkFundingGrants(guildId, 'raise what members earn');
  }
  await checkNewGrants(moduleGrantSites(moduleId, prev), moduleGrantSites(moduleId, next));
}

/**
 * For a role handed out by something that is not module settings (an event's participant role):
 * throw a RoleGrantError when the acting person may not hand out any of these roles.
 */
export function checkRoleGrants(roleIds) {
  return checkNewGrants([], roleIds.map(String));
}

/**
 * "Set XP" hands out the leveling reward roles up to the new level (syncRewards), so the
 * roles it would newly give are checked like any other grant, before the XP is written.
 * Only additions are checked, as for module saves: lowering XP takes away reward roles, which
 * are roles the leveling setup already hands out, and taking away is not a grant. A member
 * the bot cannot see is checked against the rewards they would earn on top of their current
 * level, since the bot gives those once they are back.
 */
export async function checkLevelRewardGrants(guild, userId, xp) {
  if (!actors.getStore()?.guild) return; // open mode / the bot's own writes
  const cfg = normaliseLevelingConfig((await getGuildModule(guildKey(guild), 'leveling')).config);
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const held = member
    ? [...member.roles.cache.keys()]
    : rewardRolesToAdd(cfg, levelFromXp((await getMember(guildKey(guild), userId)).xp), []);
  await checkNewGrants(held, rewardRolesToAdd(cfg, levelFromXp(xp), held));
}

setModuleConfigGuard(({ moduleId, prev, next, switchingOn }) =>
  checkModuleGrants(moduleId, prev, next, { switchingOn })
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
