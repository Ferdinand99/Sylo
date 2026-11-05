// Per-guild settings: mod-log channel, dashboard "bot master" roles, and a
// default embed colour.
import { prepare, registerPostgresBootstrap } from './driver.js';
import { splitPlatformGuildId } from '../lib/platformId.js';

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
};

/**
 * @param {string} guildId
 * @returns {Promise<{ guild_id: string, modlog_channel_id: string|null, bot_master_roles: string,
 *   embed_color: number|null, command_prefix: string|null, updated_at: number } | undefined>}
 */
export async function getGuildSettings(guildId) {
  return selectStmt.get(guildId);
}

async function put(guildId, col, value) {
  await ensureStmt.run(guildId, Date.now());
  await setCol[col].run({ g: guildId, v: value, t: Date.now() });
}

/** Set (or clear, with null) the mod-log channel for a guild. */
export async function setModlogChannel(guildId, channelId) {
  await put(guildId, 'modlog_channel_id', channelId);
}

/** Roles (besides Discord admins) allowed to manage this guild in the dashboard. */
export async function getBotMasterRoles(guildId) {
  try {
    const v = JSON.parse((await getGuildSettings(guildId))?.bot_master_roles ?? '[]');
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
/** The bot-master role list as setBotMasterRoles would store it. */
export function normaliseBotMasterRoles(guildId, roleIds) {
  const valid = (Array.isArray(roleIds) ? roleIds : []).filter((r) => /^\d{17,20}$/.test(r));
  return [...new Set(withoutEveryone(guildId, valid))].slice(0, 25);
}
export async function setBotMasterRoles(guildId, roleIds) {
  const clean = normaliseBotMasterRoles(guildId, roleIds);
  await put(guildId, 'bot_master_roles', JSON.stringify(clean));
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
}
