// Per-guild command overrides: disable a command, or restrict it to certain
// channels / roles. Enforced in bot/events/interactionCreate.js.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS command_overrides (
    guild_id         TEXT NOT NULL,
    command_name     TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    allowed_channels TEXT NOT NULL DEFAULT '[]',
    allowed_roles    TEXT NOT NULL DEFAULT '[]',
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (guild_id, command_name)
  );
`);

const selectAllStmt = prepare('SELECT * FROM command_overrides WHERE guild_id = ?');
const selectOneStmt = prepare('SELECT * FROM command_overrides WHERE guild_id = ? AND command_name = ?');
const upsertStmt = prepare(`
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
 * @returns {Promise<Map<string, { command: string, enabled: boolean, allowedChannels: string[], allowedRoles: string[] }>>}
 */
export async function getCommandOverrides(guildId) {
  return new Map((await selectAllStmt.all(guildId)).map((r) => [r.command_name, normalise(r)]));
}

/** One override, or null when the command has no override (i.e. default allow). */
export async function getCommandOverride(guildId, commandName) {
  const row = await selectOneStmt.get(guildId, commandName);
  return row ? normalise(row) : null;
}

/**
 * @param {string} guildId
 * @param {string} commandName
 * @param {{ enabled?: boolean, allowedChannels?: string[], allowedRoles?: string[] }} patch
 */
export async function setCommandOverride(guildId, commandName, patch) {
  const current = (await getCommandOverride(guildId, commandName)) ?? {
    enabled: true,
    allowedChannels: [],
    allowedRoles: [],
  };
  await upsertStmt.run({
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
