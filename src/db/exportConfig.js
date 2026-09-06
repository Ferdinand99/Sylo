// Serialise a guild's configuration for a backup / "download my setup" export.
// Deliberately excludes member data (warnings, leveling, tickets).
//
// NOT converted to the driver.js shim yet — deliberately deferred. It reads
// guild_modules directly, which is owned by modules.js; that file isn't
// converted yet (getGuildModule/isModuleEnabled are called synchronously from
// a very large number of hot-path event handlers across the codebase, likely
// the widest blast radius of any remaining src/db file, so it gets its own
// dedicated phase rather than being rushed here). Converting exportConfig.js
// before that would either skip Postgres test coverage for this file or ship
// a query against a table that doesn't exist yet on that driver — see
// docs/roadmap.md.
import { db } from './index.js';

const q = {
  settings: db.prepare('SELECT modlog_channel_id FROM guild_settings WHERE guild_id = ?'),
  modules: db.prepare('SELECT module_id, enabled, config FROM guild_modules WHERE guild_id = ?'),
  overrides: db.prepare(
    'SELECT command_name, enabled, allowed_channels, allowed_roles FROM command_overrides WHERE guild_id = ?'
  ),
  scheduled: db.prepare(
    'SELECT channel_id, content, interval_minutes, enabled FROM scheduled_messages WHERE guild_id = ?'
  ),
  counting: db.prepare('SELECT current, record FROM counting WHERE guild_id = ?'),
};

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** @param {string} guildId */
export function exportGuildConfig(guildId) {
  return {
    sylo: 'guild-config-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    guildId,
    settings: q.settings.get(guildId) ?? null,
    modules: q.modules.all(guildId).map((r) => ({
      moduleId: r.module_id,
      enabled: r.enabled === 1,
      config: parse(r.config),
    })),
    commandOverrides: q.overrides.all(guildId).map((r) => ({
      command: r.command_name,
      enabled: r.enabled === 1,
      allowedChannels: parse(r.allowed_channels) ?? [],
      allowedRoles: parse(r.allowed_roles) ?? [],
    })),
    scheduledMessages: q.scheduled.all(guildId).map((r) => ({
      channelId: r.channel_id,
      content: r.content,
      intervalMinutes: r.interval_minutes,
      enabled: r.enabled === 1,
    })),
    counting: q.counting.get(guildId) ?? null,
  };
}
