// Per-guild command overrides: disable a command, or restrict it to certain
// channels / roles. Enforced in bot/events/interactionCreate.js.
import { db } from './index.js';

const selectAllStmt = db.prepare('SELECT * FROM command_overrides WHERE guild_id = ?');
const selectOneStmt = db.prepare('SELECT * FROM command_overrides WHERE guild_id = ? AND command_name = ?');
const upsertStmt = db.prepare(`
  INSERT INTO command_overrides (guild_id, command_name, enabled, allowed_channels, allowed_roles, updated_at)
  VALUES (@guildId, @commandName, @enabled, @allowedChannels, @allowedRoles, @updatedAt)
  ON CONFLICT (guild_id, command_name) DO UPDATE SET
    enabled          = excluded.enabled,
    allowed_channels = excluded.allowed_channels,
    allowed_roles    = excluded.allowed_roles,
    updated_at       = excluded.updated_at
`);

function normalise(row) {
  return {
    command: row.command_name,
    enabled: row.enabled === 1,
    allowedChannels: safeArray(row.allowed_channels),
    allowedRoles: safeArray(row.allowed_roles),
  };
}

/**
 * All overrides for a guild, keyed by command name.
 * @param {string} guildId
 * @returns {Map<string, { command: string, enabled: boolean, allowedChannels: string[], allowedRoles: string[] }>}
 */
export function getCommandOverrides(guildId) {
  return new Map(selectAllStmt.all(guildId).map((r) => [r.command_name, normalise(r)]));
}

/** One override, or null when the command has no override (i.e. default allow). */
export function getCommandOverride(guildId, commandName) {
  const row = selectOneStmt.get(guildId, commandName);
  return row ? normalise(row) : null;
}

/**
 * @param {string} guildId
 * @param {string} commandName
 * @param {{ enabled?: boolean, allowedChannels?: string[], allowedRoles?: string[] }} patch
 */
export function setCommandOverride(guildId, commandName, patch) {
  const current = getCommandOverride(guildId, commandName) ?? {
    enabled: true,
    allowedChannels: [],
    allowedRoles: [],
  };
  upsertStmt.run({
    guildId,
    commandName,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    allowedChannels: JSON.stringify(patch.allowedChannels ?? current.allowedChannels),
    allowedRoles: JSON.stringify(patch.allowedRoles ?? current.allowedRoles),
    updatedAt: Date.now(),
  });
}

function safeArray(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
