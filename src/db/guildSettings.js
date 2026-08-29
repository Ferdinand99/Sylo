// Per-guild settings (currently: default Battlefield title and mod-log channel).
import { db } from './index.js';

const selectStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const upsertModlogStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, modlog_channel_id, updated_at)
  VALUES (@guildId, @channelId, @updatedAt)
  ON CONFLICT (guild_id) DO UPDATE SET
    modlog_channel_id = excluded.modlog_channel_id,
    updated_at        = excluded.updated_at
`);
const upsertTitleStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, default_title, updated_at)
  VALUES (@guildId, @title, @updatedAt)
  ON CONFLICT (guild_id) DO UPDATE SET
    default_title = excluded.default_title,
    updated_at    = excluded.updated_at
`);

/**
 * @param {string} guildId
 * @returns {{ guild_id: string, default_title: string | null, modlog_channel_id: string | null, updated_at: number } | undefined}
 */
export function getGuildSettings(guildId) {
  return selectStmt.get(guildId);
}

/**
 * Set (or clear, with null) the mod-log channel for a guild.
 * @param {string} guildId
 * @param {string | null} channelId
 */
export function setModlogChannel(guildId, channelId) {
  upsertModlogStmt.run({ guildId, channelId, updatedAt: Date.now() });
}

/**
 * Set (or clear, with null) the default Battlefield title used by /stats when
 * the caller omits one.
 * @param {string} guildId
 * @param {string | null} title
 */
export function setDefaultTitle(guildId, title) {
  upsertTitleStmt.run({ guildId, title, updatedAt: Date.now() });
}
