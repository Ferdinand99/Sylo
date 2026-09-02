// Temporary bans: one row per (guild, user) with the time the ban should be
// lifted. The moderation module ticks over `dueTempBans` and calls
// guild.bans.remove(). Rows are cleared on manual /unban and on guild purge.
import { db } from './index.js';

const s = {
  upsert: db.prepare(`
    INSERT INTO temp_bans (guild_id, user_id, mod_id, reason, unban_at, created_at)
    VALUES (@guildId, @userId, @modId, @reason, @unbanAt, @createdAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      mod_id = excluded.mod_id,
      reason = excluded.reason,
      unban_at = excluded.unban_at,
      created_at = excluded.created_at
  `),
  get: db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?'),
  del: db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?'),
  listGuild: db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? ORDER BY unban_at ASC'),
  due: db.prepare('SELECT * FROM temp_bans WHERE unban_at <= ?'),
  delGuild: db.prepare('DELETE FROM temp_bans WHERE guild_id = ?'),
};

/** Schedule (or reschedule) an auto-unban. */
export function scheduleTempBan({ guildId, userId, modId, reason, unbanAt }) {
  s.upsert.run({ guildId, userId, modId, reason, unbanAt, createdAt: Date.now() });
}

export const getTempBan = (guildId, userId) => s.get.get(guildId, userId) ?? null;
export const clearTempBan = (guildId, userId) => s.del.run(guildId, userId).changes;
export const guildTempBans = (guildId) => s.listGuild.all(guildId);
export const dueTempBans = (now) => s.due.all(now);
export const clearGuildTempBans = (guildId) => s.delGuild.run(guildId);
