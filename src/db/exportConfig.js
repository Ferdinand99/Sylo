// Serialise a guild's configuration for a backup / "download my setup" export.
// Deliberately excludes member data (warnings, leveling, tickets).
//
// No registerPostgresBootstrap here — this file owns no table of its own, it
// only reads tables bootstrapped by their owning files (guild_settings,
// guild_modules, command_overrides, scheduled_messages, counting) — all of
// which are converted now, so this file no longer needs to be deferred.
import { prepare } from './driver.js';

const q = {
  settings: prepare('SELECT modlog_channel_id FROM guild_settings WHERE guild_id = ?'),
  modules: prepare('SELECT module_id, enabled, config FROM guild_modules WHERE guild_id = ?'),
  overrides: prepare(
    'SELECT command_name, enabled, allowed_channels, allowed_roles FROM command_overrides WHERE guild_id = ?'
  ),
  scheduled: prepare(
    'SELECT channel_id, content, interval_minutes, enabled FROM scheduled_messages WHERE guild_id = ?'
  ),
  counting: prepare('SELECT current, record FROM counting WHERE guild_id = ?'),
};

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** @param {string} guildId */
export async function exportGuildConfig(guildId) {
  return {
    sylo: 'guild-config-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    guildId,
    settings: (await q.settings.get(guildId)) ?? null,
    modules: (await q.modules.all(guildId)).map((r) => ({
      moduleId: r.module_id,
      enabled: r.enabled === 1,
      config: parse(r.config),
    })),
    commandOverrides: (await q.overrides.all(guildId)).map((r) => ({
      command: r.command_name,
      enabled: r.enabled === 1,
      allowedChannels: parse(r.allowed_channels) ?? [],
      allowedRoles: parse(r.allowed_roles) ?? [],
    })),
    scheduledMessages: (await q.scheduled.all(guildId)).map((r) => ({
      channelId: r.channel_id,
      content: r.content,
      intervalMinutes: r.interval_minutes,
      enabled: r.enabled === 1,
    })),
    counting: (await q.counting.get(guildId)) ?? null,
  };
}
