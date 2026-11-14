// Per-guild settings: mod-log channel, dashboard "bot master" roles (and the Inbox and View access
// roles), and a default embed colour.
import { prepare, registerPostgresBootstrap } from './driver.js';
import { splitPlatformGuildId } from '../lib/platformId.js';
import { noteSettingWrite } from './auditCapture.js';
import { invalidateHealth } from '../lib/healthCache.js';

/**
 * A role id list without @everyone, whose id is the server's own id: as a bot-master or staff
 * role it would match every member.
 */
export function withoutEveryone(guildId, roleIds) {
  const everyone = splitPlatformGuildId(guildId)?.rawId ?? guildId;
  return roleIds.filter((r) => r !== everyone);
}

export const DEFAULT_EMBED_COLOR = 0x7aa2f7; // Sylo brand blue

// Column set reflects the CREATE TABLE migration plus three later
// ALTER TABLE migrations (modlog_channel_id, bot_master_roles, embed_color)
// — confirmed by grepping every `ALTER TABLE guild_settings` in MIGRATIONS,
// not just the original CREATE TABLE.
registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id          TEXT PRIMARY KEY,
    default_title     TEXT,
    updated_at        BIGINT NOT NULL,
    modlog_channel_id TEXT,
    bot_master_roles  TEXT NOT NULL DEFAULT '[]',
    embed_color       INTEGER
  );
  ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS command_prefix TEXT;
  ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS dashboard_inbox_roles TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS dashboard_view_roles TEXT NOT NULL DEFAULT '[]';
`);

const selectStmt = prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const deleteStmt = prepare('DELETE FROM guild_settings WHERE guild_id = ?');
const ensureStmt = prepare(
  'INSERT INTO guild_settings (guild_id, updated_at) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING'
);
const setCol = {
  modlog_channel_id: prepare(
    'UPDATE guild_settings SET modlog_channel_id = @v, updated_at = @t WHERE guild_id = @g'
  ),
  bot_master_roles: prepare(
    'UPDATE guild_settings SET bot_master_roles = @v, updated_at = @t WHERE guild_id = @g'
  ),
  embed_color: prepare('UPDATE guild_settings SET embed_color = @v, updated_at = @t WHERE guild_id = @g'),
  command_prefix: prepare(
    'UPDATE guild_settings SET command_prefix = @v, updated_at = @t WHERE guild_id = @g'
  ),
  dashboard_inbox_roles: prepare(
    'UPDATE guild_settings SET dashboard_inbox_roles = @v, updated_at = @t WHERE guild_id = @g'
  ),
  dashboard_view_roles: prepare(
    'UPDATE guild_settings SET dashboard_view_roles = @v, updated_at = @t WHERE guild_id = @g'
  ),
};

// Servers that give someone dashboard access through a role: a bot-master, Inbox or View role. For
// the server list, so a person who gets in through a role finds the server without a link.
const withAccessRolesStmt = prepare(
  `SELECT guild_id, bot_master_roles, dashboard_inbox_roles, dashboard_view_roles FROM guild_settings
   WHERE bot_master_roles <> '[]' OR dashboard_inbox_roles <> '[]' OR dashboard_view_roles <> '[]'`
);

/**
 * @param {string} guildId
 * @returns {Promise<{ guild_id: string, modlog_channel_id: string|null, bot_master_roles: string,
 *   embed_color: number|null, command_prefix: string|null, updated_at: number } | undefined>}
 */
export async function getGuildSettings(guildId) {
  return selectStmt.get(guildId);
}

// A setting as the change history keeps it (readable, the same on both sides of a change).
const HISTORY_NAME = {
  modlog_channel_id: 'modlogChannelId',
  embed_color: 'embedColor',
  bot_master_roles: 'botMasterRoleIds',
  command_prefix: 'commandPrefix',
};
function historyValue(col, raw) {
  if (col === 'embed_color') return Number.isInteger(raw) ? `#${raw.toString(16).padStart(6, '0')}` : '';
  if (col === 'bot_master_roles') {
    try {
      const v = JSON.parse(raw ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return raw ?? '';
}

async function put(guildId, col, value) {
  const before = (await selectStmt.get(guildId))?.[col];
  await ensureStmt.run(guildId, Date.now());
  await setCol[col].run({ g: guildId, v: value, t: Date.now() });
  // The change history of the dashboard request this write belongs to keeps what it changed.
  noteSettingWrite(guildId, HISTORY_NAME[col], historyValue(col, before), historyValue(col, value));
}

/** Set (or clear, with null) the mod-log channel for a guild. */
export async function setModlogChannel(guildId, channelId) {
  await put(guildId, 'modlog_channel_id', channelId);
  invalidateHealth(guildId);
}

/** A stored role list (JSON text) as role ids: valid ids only, never @everyone. */
function parseRoleList(guildId, text) {
  try {
    const v = JSON.parse(text ?? '[]');
    return Array.isArray(v)
      ? withoutEveryone(
          guildId,
          v.filter((r) => /^\d{17,20}$/.test(r))
        )
      : [];
  } catch {
    return [];
  }
}

/** Roles (besides Discord admins) allowed to manage this guild in the dashboard. */
export async function getBotMasterRoles(guildId) {
  return parseRoleList(guildId, (await getGuildSettings(guildId))?.bot_master_roles);
}

/**
 * Who may use the dashboard through a role, per access level (src/web/middleware/access.js):
 * `edit` are the bot-master roles, `inbox` may also act on tickets, appeals, applications and
 * suggestions, `view` may only read. One read for all three.
 * @returns {Promise<{ edit: string[], inbox: string[], view: string[] }>}
 */
export async function getDashboardAccessRoles(guildId) {
  const row = await getGuildSettings(guildId);
  return {
    edit: parseRoleList(guildId, row?.bot_master_roles),
    inbox: parseRoleList(guildId, row?.dashboard_inbox_roles),
    view: parseRoleList(guildId, row?.dashboard_view_roles),
  };
}

/** Set the Inbox and View role lists; returns them as stored. The bot-master roles are set apart. */
export async function setDashboardAccessRoles(guildId, { inbox, view }) {
  const clean = {
    inbox: normaliseBotMasterRoles(guildId, inbox),
    view: normaliseBotMasterRoles(guildId, view),
  };
  await put(guildId, 'dashboard_inbox_roles', JSON.stringify(clean.inbox));
  await put(guildId, 'dashboard_view_roles', JSON.stringify(clean.view));
  dropAccessRolesCache();
  return clean;
}

// The server list asks guildsWithAccessRoles on every load, so its answer is kept in memory: a save of
// any of the three lists here drops it, and the TTL covers a save by another process (a second replica).
const ACCESS_ROLES_TTL_MS = 60_000;
let accessRolesCache = null; // { at: number, value: Map<string, string[]> }
const dropAccessRolesCache = () => {
  accessRolesCache = null;
};

/**
 * Every server with at least one access role (bot-master, Inbox or View), with all its access roles
 * together: the roles that let someone in at all. Cached (see above).
 * @returns {Promise<Map<string, string[]>>} guild key -> role ids
 */
export async function guildsWithAccessRoles() {
  if (accessRolesCache && Date.now() - accessRolesCache.at < ACCESS_ROLES_TTL_MS)
    return accessRolesCache.value;
  const out = new Map();
  for (const row of await withAccessRolesStmt.all()) {
    const roles = [
      ...parseRoleList(row.guild_id, row.bot_master_roles),
      ...parseRoleList(row.guild_id, row.dashboard_inbox_roles),
      ...parseRoleList(row.guild_id, row.dashboard_view_roles),
    ];
    if (roles.length) out.set(row.guild_id, roles);
  }
  accessRolesCache = { at: Date.now(), value: out };
  return out;
}
/** The bot-master role list as setBotMasterRoles would store it (also the Inbox and View lists). */
export function normaliseBotMasterRoles(guildId, roleIds) {
  const valid = (Array.isArray(roleIds) ? roleIds : []).filter((r) => /^\d{17,20}$/.test(r));
  return [...new Set(withoutEveryone(guildId, valid))].slice(0, 25);
}
export async function setBotMasterRoles(guildId, roleIds) {
  const clean = normaliseBotMasterRoles(guildId, roleIds);
  await put(guildId, 'bot_master_roles', JSON.stringify(clean));
  dropAccessRolesCache();
  return clean;
}

/** Raw stored embed colour (integer) or null. */
export async function setEmbedColor(guildId, colorInt) {
  await put(guildId, 'embed_color', Number.isInteger(colorInt) ? colorInt : null);
}
/** Effective embed colour for a guild — stored value, else the Sylo default. */
export async function guildEmbedColor(guildId) {
  const c = (await getGuildSettings(guildId))?.embed_color;
  return Number.isInteger(c) ? c : DEFAULT_EMBED_COLOR;
}

// The per-server command prefix is read on every chat message, so it is cached per guild:
// no query per message. A save replaces the entry; the TTL only covers a change made by
// another process (a second replica sharing the database).
const PREFIX_TTL_MS = 10 * 60 * 1000;
const prefixCache = new Map(); // guild key -> { value: string | null, at: number }

/** Forget the cached command prefix (all guilds, or one). */
export function clearCommandPrefixCache(guildId) {
  if (guildId === undefined) prefixCache.clear();
  else prefixCache.delete(guildId);
}

/**
 * The prefix a server set for itself, or null when it uses the instance default. Cached.
 * @param {string} guildId  the guild key
 * @returns {Promise<string | null>}
 */
export async function getCommandPrefix(guildId) {
  const hit = prefixCache.get(guildId);
  if (hit && Date.now() - hit.at < PREFIX_TTL_MS) return hit.value;
  const value = (await getGuildSettings(guildId))?.command_prefix || null;
  prefixCache.set(guildId, { value, at: Date.now() });
  return value;
}

/**
 * Set (or clear, with null) a server's command prefix. The caller validates it
 * (lib/commandPrefix.js); this only stores it and refreshes the cache.
 * @param {string} guildId
 * @param {string | null} prefix
 */
export async function setCommandPrefix(guildId, prefix) {
  const value = prefix || null;
  await put(guildId, 'command_prefix', value);
  prefixCache.set(guildId, { value, at: Date.now() });
}

/** Remove all settings for a guild (used when Sylo leaves it). */
export async function deleteGuildSettings(guildId) {
  await deleteStmt.run(guildId);
  prefixCache.delete(guildId);
  dropAccessRolesCache();
}
