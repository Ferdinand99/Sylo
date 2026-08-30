// Per-guild settings (currently just the mod-log channel).
import { db } from './index.js';

const selectStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const upsertModlogStmt = db.prepare(`
  INSERT INTO guild_settings (guild_id, modlog_channel_id, updated_at)
  VALUES (@guildId, @channelId, @updatedAt)
  ON CONFLICT (guild_id) DO UPDATE SET
    modlog_channel_id = excluded.modlog_channel_id,
    updated_at        = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM guild_settings WHERE guild_id = ?');

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

/** Remove all settings for a guild (used when Sylo leaves it). */
export function deleteGuildSettings(guildId) {
  deleteStmt.run(guildId);
}
