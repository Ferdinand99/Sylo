// JSON API for the Temporary roles page of the dashboard: the module's settings, the list of active
// temporary roles (filterable), a member search for the Add form, and add / remove. Shares its rules
// with /temprole (modules/tempRoles.js).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server, the state-changing calls have passed the CSRF check and guardRoleGrants
// knows who is acting (checkRoleGrants refuses a role above the caller's own).
import { Router } from 'express';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { checkRoleGrants } from '../middleware/roleGrants.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { listTempRoles, tempRoleCount } from '../../db/tempRoles.js';
import {
  addTempRole,
  normaliseReason,
  normaliseTempRolesConfig,
  parseTempDuration,
  removeTempRole,
} from '../../modules/tempRoles.js';

/** How many rows the list returns at most (the total is always counted). */
const LIST_SHOWN = 200;
/** How many members the picker returns at most. */
const SEARCH_SHOWN = 10;

const router = Router({ mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });
const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));

const nameOf = (guild, userId) => {
  const m = guild.members?.cache?.get?.(userId);
  return m?.displayName ?? m?.user?.username ?? userId;
};

function view(row, guild) {
  const role = guild.roles.cache.get(row.role_id);
  return {
    userId: row.user_id,
    member: nameOf(guild, row.user_id),
    roleId: row.role_id,
    role: role?.name ?? row.role_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    addedBy: row.added_by,
    addedByName: row.added_by ? nameOf(guild, row.added_by) : null,
    reason: row.reason,
  };
}

/** The list for the page: rows matching the text (member name or id, role name, reason) and role. */
async function listOf(guild, query = {}) {
  const roleId = isId(query.roleId) ? String(query.roleId) : '';
  const q = String(query.q ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 100);
  const all = (await listTempRoles(guild.id, { limit: 2000 }))
    .filter((r) => !roleId || r.role_id === roleId)
    .map((r) => view(r, guild));
  const rows = q
    ? all.filter((r) =>
        [r.member, r.userId, r.role, r.reason].some((v) => String(v).toLowerCase().includes(q))
      )
    : all;
  return { total: await tempRoleCount(guild.id), matching: rows.length, rows: rows.slice(0, LIST_SHOWN) };
}

const settingsOf = async (guildId) =>
  normaliseTempRolesConfig((await getGuildModule(guildId, 'temp-roles')).config);

router.get(
  '/modules/temp-roles/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await settingsOf(req.guild.id),
      roles: assignableRoles(req.guild),
      list: await listOf(req.guild),
    });
  })
);

router.post(
  '/modules/temp-roles/config',
  asyncHandler(async (req, res) => {
    const config = normaliseTempRolesConfig(req.body);
    await setGuildModule(req.guild.id, 'temp-roles', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:temp-roles',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/modules/temp-roles/list',
  asyncHandler(async (req, res) => {
    res.json({ list: await listOf(req.guild, req.query) });
  })
);

// Members of this server by name, for the Add form. Looks at the members Sylo has cached; a pasted
// member id is looked up directly.
router.get(
  '/modules/temp-roles/members',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 100);
    if (!q) return res.json({ members: [] });
    const found = [];
    if (isId(q)) {
      const m = req.guild.members.cache.get(q) ?? (await req.guild.members.fetch(q).catch(() => null));
      if (m) found.push(m);
    } else {
      for (const m of req.guild.members.cache.values()) {
        if (m.user?.bot) continue;
        const names = [m.displayName, m.user?.username, m.user?.tag].map((v) =>
          String(v ?? '').toLowerCase()
        );
        if (names.some((n) => n.includes(q))) found.push(m);
        if (found.length >= SEARCH_SHOWN) break;
      }
    }
    res.json({
      members: found.slice(0, SEARCH_SHOWN).map((m) => ({
        id: m.id,
        name: m.displayName ?? m.user?.username ?? m.id,
        username: m.user?.username ?? '',
      })),
    });
  })
);

router.post(
  '/modules/temp-roles/add',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const mod = await getGuildModule(guild.id, 'temp-roles');
    if (!mod.enabled) return fail(res, 'Turn the Temporary roles module on first.');
    const cfg = normaliseTempRolesConfig(mod.config);

    const userId = String(req.body?.userId ?? '');
    if (!isId(userId)) return fail(res, 'Pick a member.');
    const roleId = String(req.body?.roleId ?? '');
    if (!assignableRoles(guild).some((r) => r.id === roleId)) return fail(res, 'Pick a role from the list.');
    const duration = parseTempDuration(req.body?.duration);
    if (!duration.ok) return fail(res, duration.error);
    await checkRoleGrants([roleId]); // throws a RoleGrantError (403) for a role the person may not hand out

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return fail(res, 'That person is not in this server.');
    const result = await addTempRole({
      guild,
      member,
      role: guild.roles.cache.get(roleId),
      durationMs: duration.ms,
      addedBy: actingUserId(req, guild.id, null),
      reason: normaliseReason(req.body?.reason),
      cfg,
    });
    if (!result.ok) return fail(res, result.error);
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'module:temp-roles',
      detail: `${result.replaced ? 'replaced' : 'added'} ${nameOf(guild, userId)} / ${guild.roles.cache.get(roleId).name}`,
    });
    res.json({
      replaced: result.replaced,
      alreadyHadRole: result.alreadyHadRole,
      dm: result.dm,
      expiresAt: result.expiresAt,
      list: await listOf(guild, req.body?.filter),
    });
  })
);

router.post(
  '/modules/temp-roles/remove',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = String(req.body?.userId ?? '');
    const roleId = String(req.body?.roleId ?? '');
    if (!isId(userId) || !isId(roleId)) return fail(res, 'Pick a member and a role.');
    const role = guild.roles.cache.get(roleId);
    if (role) await checkRoleGrants([roleId]); // taking back a role above your own is refused too
    const cfg = await settingsOf(guild.id);
    const result = await removeTempRole({
      guild,
      userId,
      roleId,
      by: actingUserId(req, guild.id, null),
      reason: normaliseReason(req.body?.reason),
      cfg,
    });
    if (!result.ok) return fail(res, result.error, 404);
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'module:temp-roles',
      detail: `removed ${nameOf(guild, userId)} / ${role?.name ?? roleId}`,
    });
    res.json({
      roleRemoved: result.roleRemoved,
      warning: result.warning ?? null,
      list: await listOf(guild, req.body?.filter),
    });
  })
);

export default router;
