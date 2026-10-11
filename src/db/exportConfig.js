// Serialise a guild's configuration for a backup / "download my setup" export.
// Deliberately excludes member data (warnings, leveling, tickets).
//
// No registerPostgresBootstrap here — this file owns no table of its own, it
// only reads tables bootstrapped by their owning files (guild_settings,
// guild_modules, command_overrides, scheduled_messages, counting) — all of
// which are converted now, so this file no longer needs to be deferred.
import { prepare, runAtomicWrites } from './driver.js';

import { getModule } from '../modules/registry.js';
import { listComposed } from './composedMessages.js';
import { listScheduled } from './scheduledMessages.js';

const q = {
  settings: prepare(
    'SELECT modlog_channel_id, bot_master_roles, embed_color FROM guild_settings WHERE guild_id = ?'
  ),
  modules: prepare('SELECT module_id, enabled, config FROM guild_modules WHERE guild_id = ?'),
  overrides: prepare(
    'SELECT command_name, enabled, allowed_channels, allowed_roles FROM command_overrides WHERE guild_id = ?'
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
    version: 2,
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
    composedMessages: (await listComposed(guildId, 200)).map((row) => ({
      name: row.name,
      channelId: row.channel_id,
      messageId: row.message_id,
      spec: row.spec,
    })),
    scheduledMessages: (await listScheduled(guildId)).map((row) => ({
      name: row.name,
      channelId: row.channel_id,
      spec: row.spec,
      content: row.content,
      mode: row.mode,
      days: row.dayList,
      intervalMinutes: row.interval_minutes,
      startAt: row.start_at,
      endAt: row.end_at,
      runAt: row.run_at,
      enabled: row.enabled === 1,
    })),
    counting: (await q.counting.get(guildId)) ?? null,
  };
}

/** Validate the entire file before atomically restoring this guild's setup. */
export async function importGuildConfig(guildId, backup) {
  const fail = (message) => {
    throw new Error(message);
  };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const id = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
  const ids = (value) => Array.isArray(value) && value.length <= 100 && value.every(id);
  if (!object(backup) || backup.sylo !== 'guild-config-export' || ![1, 2].includes(backup.version))
    fail('To nie jest obsługiwany plik konfiguracji bota.');
  if (backup.guildId !== guildId) fail('Plik pochodzi z innego serwera Discord.');
  const operations = [],
    now = Date.now();
  const write = (sql, ...args) => operations.push({ sql, args });
  if (backup.settings != null) {
    const settings = backup.settings;
    if (!object(settings) || (settings.modlog_channel_id != null && !id(settings.modlog_channel_id)))
      fail('Niepoprawne ustawienia serwera.');
    let roles = [];
    try {
      roles =
        typeof settings.bot_master_roles === 'string'
          ? JSON.parse(settings.bot_master_roles)
          : settings.bot_master_roles || [];
    } catch {
      fail('Niepoprawne role administratorów panelu.');
    }
    if (!ids(roles) || roles.length > 25) fail('Niepoprawne role administratorów panelu.');
    const color = settings.embed_color ?? null;
    if (color !== null && (!Number.isInteger(color) || color < 0 || color > 0xffffff))
      fail('Niepoprawny kolor embedów.');
    // Legacy files only restore the settings actually present in the file.
    write(
      'INSERT INTO guild_settings (guild_id, updated_at) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING',
      guildId,
      now
    );
    write(
      'UPDATE guild_settings SET modlog_channel_id = ?, updated_at = ? WHERE guild_id = ?',
      settings.modlog_channel_id ?? null,
      now,
      guildId
    );
    if ('bot_master_roles' in settings)
      write(
        'UPDATE guild_settings SET bot_master_roles = ? WHERE guild_id = ?',
        JSON.stringify(roles),
        guildId
      );
    if ('embed_color' in settings)
      write('UPDATE guild_settings SET embed_color = ? WHERE guild_id = ?', color, guildId);
  }
  if (!Array.isArray(backup.modules) || backup.modules.length > 100) fail('Niepoprawna lista modułów.');
  const seen = new Set();
  for (const row of backup.modules) {
    if (
      !object(row) ||
      !getModule(row.moduleId) ||
      seen.has(row.moduleId) ||
      typeof row.enabled !== 'boolean' ||
      !object(row.config)
    )
      fail('Niepoprawna konfiguracja modułu.');
    seen.add(row.moduleId);
    write(
      `INSERT INTO guild_modules (guild_id, module_id, enabled, config, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, module_id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`,
      guildId,
      row.moduleId,
      row.enabled ? 1 : 0,
      JSON.stringify(row.config),
      now
    );
  }
  if (backup.commandOverrides !== undefined) {
    if (!Array.isArray(backup.commandOverrides) || backup.commandOverrides.length > 200)
      fail('Niepoprawna lista komend.');
    write('DELETE FROM command_overrides WHERE guild_id = ?', guildId);
    for (const row of backup.commandOverrides) {
      if (
        !object(row) ||
        !/^[a-z0-9_-]{1,32}$/.test(row.command || '') ||
        typeof row.enabled !== 'boolean' ||
        !ids(row.allowedChannels) ||
        !ids(row.allowedRoles)
      )
        fail('Niepoprawne uprawnienia komendy.');
      write(
        'INSERT INTO command_overrides (guild_id, command_name, enabled, allowed_channels, allowed_roles, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        guildId,
        row.command,
        row.enabled ? 1 : 0,
        JSON.stringify(row.allowedChannels),
        JSON.stringify(row.allowedRoles),
        now
      );
    }
  }
  if (backup.composedMessages !== undefined) {
    if (!Array.isArray(backup.composedMessages) || backup.composedMessages.length > 200)
      fail('Niepoprawna lista zapisanych wiadomości.');
    write('DELETE FROM composed_messages WHERE guild_id = ?', guildId);
    for (const row of backup.composedMessages) {
      if (
        !object(row) ||
        typeof row.name !== 'string' ||
        row.name.length > 100 ||
        !object(row.spec) ||
        (row.channelId && !id(row.channelId)) ||
        (row.messageId != null && !id(row.messageId))
      )
        fail('Niepoprawna zapisana wiadomość.');
      write(
        'INSERT INTO composed_messages (guild_id, name, channel_id, message_id, spec, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        guildId,
        row.name,
        row.channelId || '',
        row.messageId ?? null,
        JSON.stringify(row.spec),
        now
      );
    }
  }
  if (backup.scheduledMessages !== undefined) {
    if (!Array.isArray(backup.scheduledMessages) || backup.scheduledMessages.length > 200)
      fail('Niepoprawna lista przypomnień.');
    write('DELETE FROM scheduled_messages WHERE guild_id = ?', guildId);
    for (const row of backup.scheduledMessages) {
      const interval = row.intervalMinutes;
      const days = row.days ?? [0, 1, 2, 3, 4, 5, 6];
      if (
        !object(row) ||
        !id(row.channelId) ||
        !Number.isInteger(interval) ||
        interval < 1 ||
        interval > 525600 ||
        !Array.isArray(days) ||
        !days.length ||
        days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        (row.mode !== undefined && !['single', 'multiple'].includes(row.mode)) ||
        [row.startAt, row.endAt, row.runAt].some(
          (at) => at != null && (!Number.isSafeInteger(Number(at)) || Number(at) < 0)
        )
      )
        fail('Niepoprawne przypomnienie.');
      const spec = row.spec ?? { content: String(row.content || ''), embeds: [] };
      if (!object(spec)) fail('Niepoprawna treść przypomnienia.');
      write(
        `INSERT INTO scheduled_messages (guild_id, name, channel_id, content, spec, mode, days, interval_minutes,
        start_at, end_at, run_at, next_run_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        guildId,
        String(row.name || '').slice(0, 100),
        row.channelId,
        String(spec.content || '').slice(0, 2000),
        JSON.stringify(spec),
        row.mode || 'multiple',
        days.join(','),
        interval,
        row.startAt ?? null,
        row.endAt ?? null,
        row.runAt ?? null,
        Math.max(now + interval * 60000, Number(row.startAt) || 0),
        row.enabled === false ? 0 : 1,
        now
      );
    }
  }
  await runAtomicWrites(operations);
}
