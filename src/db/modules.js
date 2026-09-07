// Per-guild module enable state and JSON config.
import { prepare, registerPostgresBootstrap } from './driver.js';
import { MODULES, getModule } from '../modules/registry.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_modules (
    guild_id   TEXT NOT NULL,
    module_id  TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, module_id)
  );
`);

const selectAllStmt = prepare('SELECT module_id, enabled, config FROM guild_modules WHERE guild_id = ?');
const selectOneStmt = prepare(
  'SELECT enabled, config FROM guild_modules WHERE guild_id = ? AND module_id = ?'
);
const upsertStmt = prepare(`
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
 * @returns {Promise<Array<{ id: string, enabled: boolean, config: object }>>}
 */
export async function getGuildModules(guildId) {
  const rows = new Map((await selectAllStmt.all(guildId)).map((r) => [r.module_id, r]));
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
 * @returns {Promise<{ enabled: boolean, config: object }>}
 */
export async function getGuildModule(guildId, moduleId) {
  const row = await selectOneStmt.get(guildId, moduleId);
  if (row) return { enabled: row.enabled === 1, config: safeParse(row.config) };
  const mod = getModule(moduleId);
  return { enabled: mod ? mod.defaultEnabled : false, config: {} };
}

/** True if the module is on for the guild. */
export async function isModuleEnabled(guildId, moduleId) {
  return (await getGuildModule(guildId, moduleId)).enabled;
}

/**
 * Set enabled state and/or config for a module. Missing fields keep their
 * current value.
 * @param {string} guildId
 * @param {string} moduleId
 * @param {{ enabled?: boolean, config?: object }} patch
 */
export async function setGuildModule(guildId, moduleId, patch) {
  const current = await getGuildModule(guildId, moduleId);
  await upsertStmt.run({
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
