// Per-guild module enable state and JSON config.
import { db } from './index.js';
import { MODULES, getModule } from '../modules/registry.js';

const selectAllStmt = db.prepare('SELECT module_id, enabled, config FROM guild_modules WHERE guild_id = ?');
const selectOneStmt = db.prepare('SELECT enabled, config FROM guild_modules WHERE guild_id = ? AND module_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO guild_modules (guild_id, module_id, enabled, config, updated_at)
  VALUES (@guildId, @moduleId, @enabled, @config, @updatedAt)
  ON CONFLICT (guild_id, module_id) DO UPDATE SET
    enabled    = excluded.enabled,
    config     = excluded.config,
    updated_at = excluded.updated_at
`);

/**
 * State for every module in a guild, merging stored rows with registry defaults.
 * @param {string} guildId
 * @returns {Array<{ id: string, enabled: boolean, config: object }>}
 */
export function getGuildModules(guildId) {
  const rows = new Map(selectAllStmt.all(guildId).map((r) => [r.module_id, r]));
  return MODULES.map((mod) => {
    const row = rows.get(mod.id);
    return {
      id: mod.id,
      enabled: row ? row.enabled === 1 : mod.defaultEnabled,
      config: row ? safeParse(row.config) : {},
    };
  });
}

/**
 * Enabled state + config for one module (falls back to the registry default).
 * @param {string} guildId
 * @param {string} moduleId
 * @returns {{ enabled: boolean, config: object }}
 */
export function getGuildModule(guildId, moduleId) {
  const row = selectOneStmt.get(guildId, moduleId);
  if (row) return { enabled: row.enabled === 1, config: safeParse(row.config) };
  const mod = getModule(moduleId);
  return { enabled: mod ? mod.defaultEnabled : false, config: {} };
}

/** True if the module is on for the guild. */
export function isModuleEnabled(guildId, moduleId) {
  return getGuildModule(guildId, moduleId).enabled;
}

/**
 * Set enabled state and/or config for a module. Missing fields keep their
 * current value.
 * @param {string} guildId
 * @param {string} moduleId
 * @param {{ enabled?: boolean, config?: object }} patch
 */
export function setGuildModule(guildId, moduleId, patch) {
  const current = getGuildModule(guildId, moduleId);
  upsertStmt.run({
    guildId,
    moduleId,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    config: JSON.stringify(patch.config ?? current.config),
    updatedAt: Date.now(),
  });
}

function safeParse(json) {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}
