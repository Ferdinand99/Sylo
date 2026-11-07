// Temporary roles: staff give a member a role for a set time (/temprole add, or the dashboard) and
// Sylo takes it back when the time is up. Every temporary role is a row in guild_temp_roles
// (db/tempRoles.js), so nothing is lost on a restart; a sweep on the scheduler every minute removes
// the roles that have run out. There are no timers per role.
//
// Adding the same member and role again REPLACES the expiry (the new time counts from now, shorter
// or longer). A mod-log entry is written on add, on early removal and on expiry, and the member can
// get a DM about it (off by default).
//
// config shape: { staffRoles, dmMember, defaultDuration }
import { EmbedBuilder } from 'discord.js';
import { getGuildModule } from '../db/modules.js';
import { allClientsReady, clientOfGuild, guildByKey, guildKey, rawGuildId } from '../platform/platformOf.js';
import {
  deleteTempRole,
  deleteTempRoleAt,
  deleteTempRolesOfUser,
  dueTempRoles,
  getTempRole,
  putTempRole,
  tempRoleCount,
} from '../db/tempRoles.js';
import { LIMITS as CEILINGS, checkLimit } from '../lib/limits.js';
import { log } from '../lib/log.js';
import { formatDuration } from '../bot/lib/duration.js';
import { postModLog } from '../bot/lib/modlog.js';
import { idList } from '../web/lib/idList.js';
import { on } from './dispatch.js';
import { every } from './schedule.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  reason: { maxLength: 500 },
  staffRoles: { maxItems: 25 },
};

/** The shortest and longest time a role can be given for. */
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 365 * 86_400_000;
export const DEFAULT_DURATION = '7d';
/** How often the sweep looks for roles that have run out. */
export const SWEEP_MS = 60_000;

const UNIT_MS = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 };
const DM_COLOR = 0x4aa3df;
const COLORS = { add: 0x57f287, remove: 0xfaa61a, expire: 0x4aa3df };

const text = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// --- duration ---------------------------------------------------------------------------------

/**
 * Read a duration such as `30m`, `12h`, `7d`, `2w` or a combination like `1d12h` (spaces between
 * the parts are fine). Units are w, d, h and m; each one at most once. At least 1 minute and at most
 * 365 days. A bare number is refused: minutes or days would be a guess.
 * @param {unknown} input
 * @returns {{ ok: true, ms: number } | { ok: false, error: string }}
 */
export function parseTempDuration(input) {
  const raw = String(input ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const hint = 'Write the time like 30m, 12h, 7d, 2w or 1d12h.';
  if (!raw) return fail(`Give a duration. ${hint}`);
  if (!/^(?:\d{1,6}[wdhm])+$/.test(raw)) return fail(`"${text(input, 40)}" is not a duration. ${hint}`);
  let total = 0;
  const seen = new Set();
  for (const [, amount, unit] of raw.matchAll(/(\d+)([wdhm])/g)) {
    if (seen.has(unit)) return fail(`Use each unit once, for example 1d12h. ${hint}`);
    seen.add(unit);
    total += Number(amount) * UNIT_MS[unit];
  }
  if (total < MIN_DURATION_MS) return fail('The shortest time is 1 minute (1m).');
  if (total > MAX_DURATION_MS) return fail('The longest time is 365 days (365d).');
  return { ok: true, ms: total };
}

// --- settings and text ------------------------------------------------------------------------

/** Server-wide settings. */
export function normaliseTempRolesConfig(raw = {}) {
  const typed = String(raw.defaultDuration ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 30);
  return {
    staffRoles: idList(raw.staffRoles, LIMITS.staffRoles.maxItems),
    dmMember: Boolean(raw.dmMember),
    // what the dashboard's "Add" form starts with
    defaultDuration: parseTempDuration(typed).ok ? typed : DEFAULT_DURATION,
  };
}

/** A staff reason, cut to the limit. */
export const normaliseReason = (v) => text(v, LIMITS.reason.maxLength);

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false;
  }
};

/**
 * Who may give and take temporary roles: Manage Roles or Administrator, or one of the staff roles
 * set on the module's page. Whether they may hand out a particular role is a separate check
 * (web/middleware/roleGrants.js).
 * @param {{ roles?: { cache?: { has(id: string): boolean } } } | null} member
 * @param {any} permissions  the member's permissions in the guild
 * @param {{ staffRoles?: string[] }} cfg
 */
export function canManageTempRoles(member, permissions, cfg = {}) {
  if (['ManageRoles', 'Administrator'].some((p) => hasPermission(permissions, p))) return true;
  const roles = Array.isArray(cfg.staffRoles) ? cfg.staffRoles : [];
  return roles.some((id) => member?.roles?.cache?.has?.(id));
}

/**
 * Why Sylo itself cannot hand out or take back this role, or null when it can.
 * @returns {string|null}
 */
export function botRefusal(guild, role) {
  if (!role) return 'That role no longer exists.';
  if (role.id === rawGuildId(guild)) return "@everyone can't be a temporary role.";
  if (role.managed) return 'That role is managed by an integration and cannot be given by hand.';
  const me = guild.members?.me;
  if (!me?.permissions?.has?.('ManageRoles')) return 'Sylo needs the Manage Roles permission for this.';
  if (role.editable === false || !(me.roles.highest.comparePositionTo(role) > 0)) {
    return "That role is above Sylo's highest role. Move Sylo's role higher in the server's role list.";
  }
  return null;
}

// --- helpers ----------------------------------------------------------------------------------

const unix = (ms) => Math.floor(ms / 1000);

/** One line for a list: who, which role, when, set by whom and why. */
export function describeTempRole(row) {
  const bits = [
    `<@${row.user_id}> · <@&${row.role_id}> · ends <t:${unix(row.expires_at)}:f> (<t:${unix(row.expires_at)}:R>)`,
  ];
  if (row.added_by) bits.push(`by <@${row.added_by}>`);
  if (row.reason) bits.push(`"${row.reason.slice(0, 80)}${row.reason.length > 80 ? '…' : ''}"`);
  return bits.join(' · ');
}

async function memberOf(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

/** The platform says the member or role no longer exists. */
const isGone = (err) => err?.status === 404 || err?.code === 10007 || err?.code === 10011;

/** One create or replace at a time per server, so the ceiling cannot be passed by two at once. */
const chains = new Map();
async function withLock(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

const auditReason = (what, reason) => `${what}${reason ? `: ${reason}` : ''}`.slice(0, 480);

async function sendDm(guild, userId, content) {
  try {
    const user = await clientOfGuild(guild).users.fetch(userId);
    await user.send({
      embeds: [new EmbedBuilder().setColor(DM_COLOR).setDescription(content.slice(0, 2000))],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch {
    return false; // DMs closed, or the person left: nothing to report
  }
}

function logEmbed(kind, title, { row, role, by, extra = [] }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[kind])
    .setTitle(title)
    .addFields(
      { name: 'Member', value: `<@${row.user_id}> (\`${row.user_id}\`)`, inline: true },
      { name: 'Role', value: `<@&${row.role_id}>${role ? ` (${role.name})` : ''}`, inline: true },
      ...extra
    )
    .setTimestamp(Date.now());
  if (by !== undefined) embed.addFields({ name: 'By', value: by ? `<@${by}>` : 'Sylo (automatic)' });
  if (row.reason) embed.addFields({ name: 'Reason', value: row.reason.slice(0, 1000) });
  return embed;
}

// --- add --------------------------------------------------------------------------------------

/**
 * Give a member a role for a while. The caller has checked who may do this and that they may hand
 * this role out (web/middleware/roleGrants.js). A second add for the same member and role REPLACES
 * the expiry. The role is added first and the row stored with it; if the platform refuses, nothing
 * is left behind.
 * @param {{ guild: any, member: any, role: any, durationMs: number, addedBy?: string|null,
 *   reason?: string, cfg?: object }} args
 * @returns {Promise<{ ok: true, expiresAt: number, replaced: boolean, previousExpiresAt: number|null,
 *   alreadyHadRole: boolean, dm: boolean } | { ok: false, error: string }>}
 */
export async function addTempRole({
  guild,
  member,
  role,
  durationMs,
  addedBy = null,
  reason = '',
  cfg = {},
}) {
  if (!member) return fail('That person is not in this server.');
  const refusal = botRefusal(guild, role);
  if (refusal) return fail(refusal);
  if (!(durationMs >= MIN_DURATION_MS && durationMs <= MAX_DURATION_MS)) {
    return fail('The time must be between 1 minute and 365 days.');
  }
  const guildId = guildKey(guild);
  const cleanReason = normaliseReason(reason);

  const done = await withLock(guildId, async () => {
    const existing = await getTempRole(guildId, member.id, role.id);
    if (!existing) {
      try {
        checkLimit(await tempRoleCount(guildId), CEILINGS.tempRoles, 'active temporary roles');
      } catch (err) {
        return fail(`${err.message} Remove some on the dashboard first.`);
      }
    }
    const expiresAt = Date.now() + durationMs;
    await putTempRole({
      guildId,
      userId: member.id,
      roleId: role.id,
      expiresAt,
      addedBy,
      reason: cleanReason,
    });
    const alreadyHadRole = member.roles.cache.has(role.id);
    if (!alreadyHadRole) {
      try {
        await member.roles.add(role, auditReason('Temporary role', cleanReason));
      } catch (err) {
        // Put the record back as it was, so no role is left behind without a way to take it back.
        if (existing) {
          await putTempRole({
            guildId,
            userId: member.id,
            roleId: role.id,
            expiresAt: existing.expires_at,
            addedBy: existing.added_by,
            reason: existing.reason,
            createdAt: existing.created_at,
          });
        } else {
          await deleteTempRole(guildId, member.id, role.id);
        }
        log.warn('temp-roles', `could not give ${role.id} to ${member.id}:`, err.message);
        return fail(
          'Sylo could not give that role. Check that its role sits above the role and has Manage Roles.'
        );
      }
    }
    return {
      ok: true,
      expiresAt,
      replaced: Boolean(existing),
      previousExpiresAt: existing ? existing.expires_at : null,
      alreadyHadRole: alreadyHadRole && !existing,
    };
  });
  if (!done.ok) return done;

  const row = { guild_id: guildId, user_id: member.id, role_id: role.id, reason: cleanReason };
  await postModLog(
    guild,
    logEmbed('add', done.replaced ? 'Temporary role replaced' : 'Temporary role added', {
      row,
      role,
      by: addedBy,
      extra: [
        {
          name: 'Until',
          value: `<t:${unix(done.expiresAt)}:f> (${formatDuration(durationMs)})`,
          inline: true,
        },
        ...(done.replaced
          ? [{ name: 'Replaces', value: `ended <t:${unix(done.previousExpiresAt)}:f>`, inline: true }]
          : []),
      ],
    })
  );
  const dm =
    cfg.dmMember === true &&
    (await sendDm(
      guild,
      member.id,
      `You were given the role **${role.name}** in **${guild.name}** until <t:${unix(done.expiresAt)}:f>.${
        cleanReason ? `\n**Reason:** ${cleanReason}` : ''
      }`
    ));
  return { ...done, dm: Boolean(dm) };
}

// --- remove -----------------------------------------------------------------------------------

/**
 * Take a temporary role back before its time. The record is always deleted; when Sylo cannot take
 * the role away (permissions changed meanwhile) the answer carries a `warning` so the person can do
 * it by hand.
 * @returns {Promise<{ ok: true, roleRemoved: boolean, warning?: string, dm: boolean } | { ok: false, error: string }>}
 */
export async function removeTempRole({ guild, userId, roleId, by = null, reason = '', cfg = {} }) {
  const guildId = guildKey(guild);
  const row = await getTempRole(guildId, userId, roleId);
  if (!row) return fail('That member does not have that role as a temporary role.');
  const role = guild.roles.cache.get(roleId) ?? null;
  const cleanReason = normaliseReason(reason);

  let roleRemoved = false;
  let warning;
  const member = role ? await memberOf(guild, userId) : null;
  if (member?.roles.cache.has(roleId)) {
    const refusal = botRefusal(guild, role);
    if (refusal) {
      warning = `${refusal} The record is gone, but the role is still on the member.`;
    } else {
      try {
        await member.roles.remove(role, auditReason('Temporary role removed early', cleanReason));
        roleRemoved = true;
      } catch (err) {
        if (!isGone(err)) {
          warning =
            'Sylo could not take the role away. The record is gone, but the role is still on the member.';
          log.warn('temp-roles', `could not remove ${roleId} from ${userId}:`, err.message);
        }
      }
    }
  }
  await deleteTempRole(guildId, userId, roleId);

  await postModLog(
    guild,
    logEmbed('remove', 'Temporary role removed early', {
      row: { ...row, reason: cleanReason || row.reason },
      role,
      by,
      extra: [{ name: 'Was due', value: `<t:${unix(row.expires_at)}:f>`, inline: true }],
    })
  );
  const dm =
    cfg.dmMember === true &&
    roleRemoved &&
    (await sendDm(guild, userId, `The role **${role.name}** was taken away early in **${guild.name}**.`));
  return { ok: true, roleRemoved, ...(warning ? { warning } : {}), dm: Boolean(dm) };
}

// --- expiry -----------------------------------------------------------------------------------

const warned = new Set();
/** A problem that repeats every minute is logged once per row. */
function warnOnce(row, message) {
  const key = `${row.guild_id}:${row.user_id}:${row.role_id}:${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(
    'temp-roles',
    `${message} (member ${row.user_id}, role ${row.role_id}); trying again every minute.`
  );
}

/**
 * Deal with one row whose time has come. A row is deleted only when the role is off the member (or
 * the member or role no longer exists); when Sylo cannot take it away now, the row stays and the next
 * sweep tries again.
 */
async function settle(row, now) {
  const guild = guildByKey(row.guild_id);
  if (!guild) return; // that platform is not connected right now: try again later
  const fresh = await getTempRole(row.guild_id, row.user_id, row.role_id);
  if (!fresh || fresh.expires_at > now) return; // taken back or extended meanwhile
  const drop = () => deleteTempRoleAt(row.guild_id, row.user_id, row.role_id, fresh.expires_at);

  const role = guild.roles.cache.get(row.role_id);
  if (!role) return void (await drop()); // the role was deleted

  let member;
  try {
    member = guild.members.cache.get(row.user_id) ?? (await guild.members.fetch(row.user_id));
  } catch (err) {
    if (!isGone(err)) throw err; // a hiccup: the next sweep tries again
    member = null;
  }
  if (!member) return void (await drop()); // the member left
  if (!member.roles.cache.has(role.id)) return void (await drop()); // taken off by hand

  const refusal = botRefusal(guild, role);
  if (refusal) return warnOnce(row, refusal);
  try {
    await member.roles.remove(role, auditReason('Temporary role expired', fresh.reason));
  } catch (err) {
    if (!isGone(err)) return warnOnce(row, `could not remove the role: ${err.message}`);
  }
  await drop();

  await postModLog(
    guild,
    logEmbed('expire', 'Temporary role expired', {
      row: fresh,
      role,
      by: null,
      extra: [{ name: 'Was set', value: `<t:${unix(fresh.created_at)}:f>`, inline: true }],
    })
  );
  const mod = await getGuildModule(row.guild_id, 'temp-roles');
  if (normaliseTempRolesConfig(mod.config).dmMember) {
    await sendDm(guild, row.user_id, `Your role **${role.name}** in **${guild.name}** has ended.`);
  }
}

/**
 * Take back every temporary role whose time has passed, in every server. Runs on the scheduler.
 * @param {number} [now]
 */
export async function sweep(now = Date.now()) {
  if (!allClientsReady()) return;
  for (const row of await dueTempRoles(now, 5000)) {
    await settle(row, now).catch((err) =>
      log.error('temp-roles', `expiry of ${row.role_id} for ${row.user_id} failed:`, err.message)
    );
  }
}

every('temp-roles', SWEEP_MS, () => sweep());

// --- keeping the records true -----------------------------------------------------------------

// A role taken off by hand needs no record any more. Needs the Server Members intent to be seen;
// without it the sweep notices when the time is up.
on('temp-roles', 'guildMemberUpdate', async ({ old: before, new: after }, _config, guildId) => {
  if (!before?.roles?.cache || !after?.roles?.cache || before === after) return;
  for (const id of before.roles.cache.keys()) {
    if (!after.roles.cache.has(id)) await deleteTempRole(guildId, after.id, id);
  }
});

// A member who left has nothing to take back.
on('temp-roles', 'guildMemberRemove', async (member, _config, guildId) => {
  const userId = member.id ?? member.user?.id;
  if (userId) await deleteTempRolesOfUser(guildId, userId);
});
