// Per-guild settings: mod-log channel, dashboard "bot master" roles, and a
// default embed colour.
import { db } from './index.js';

export const DEFAULT_EMBED_COLOR = 0x7aa2f7; // Sylo brand blue

const selectStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const deleteStmt = db.prepare('DELETE FROM guild_settings WHERE guild_id = ?');
const ensureStmt = db.prepare(
  'INSERT INTO guild_settings (guild_id, updated_at) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING'
);
const setCol = {
  modlog_channel_id: db.prepare(
    'UPDATE guild_settings SET modlog_channel_id = @v, updated_at = @t WHERE guild_id = @g'
  ),
  bot_master_roles: db.prepare(
    'UPDATE guild_settings SET bot_master_roles = @v, updated_at = @t WHERE guild_id = @g'
  ),
  embed_color: db.prepare('UPDATE guild_settings SET embed_color = @v, updated_at = @t WHERE guild_id = @g'),
};

/**
 * @param {string} guildId
 * @returns {{ guild_id: string, modlog_channel_id: string|null, bot_master_roles: string,
 *   embed_color: number|null, updated_at: number } | undefined}
 */
export function getGuildSettings(guildId) {
  return selectStmt.get(guildId);
}

function put(guildId, col, value) {
  ensureStmt.run(guildId, Date.now());
  setCol[col].run({ g: guildId, v: value, t: Date.now() });
}

/** Set (or clear, with null) the mod-log channel for a guild. */
export function setModlogChannel(guildId, channelId) {
  put(guildId, 'modlog_channel_id', channelId);
}

/** Roles (besides Discord admins) allowed to manage this guild in the dashboard. */
export function getBotMasterRoles(guildId) {
  try {
    const v = JSON.parse(getGuildSettings(guildId)?.bot_master_roles ?? '[]');
    return Array.isArray(v) ? v.filter((r) => /^\d{17,20}$/.test(r)) : [];
  } catch {
    return [];
  }
}
export function setBotMasterRoles(guildId, roleIds) {
  const clean = [
    ...new Set((Array.isArray(roleIds) ? roleIds : []).filter((r) => /^\d{17,20}$/.test(r))),
  ].slice(0, 25);
  put(guildId, 'bot_master_roles', JSON.stringify(clean));
  return clean;
}

/** Raw stored embed colour (integer) or null. */
export function setEmbedColor(guildId, colorInt) {
  put(guildId, 'embed_color', Number.isInteger(colorInt) ? colorInt : null);
}
/** Effective embed colour for a guild — stored value, else the Sylo default. */
export function guildEmbedColor(guildId) {
  const c = getGuildSettings(guildId)?.embed_color;
  return Number.isInteger(c) ? c : DEFAULT_EMBED_COLOR;
}

/** Remove all settings for a guild (used when Sylo leaves it). */
export function deleteGuildSettings(guildId) {
  deleteStmt.run(guildId);
}
