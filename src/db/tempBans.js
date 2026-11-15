// Temporary bans: one row per (guild, user) with the time the ban should be
// lifted. The moderation module ticks over `dueTempBans` and calls
// guild.bans.remove(). A row is cleared when the ban is lifted (every ban-removed event, on Discord and
// Fluxer, whatever modules are on; /unban; an accepted appeal), when Sylo places a permanent ban
// (/ban without a duration, the warn-threshold auto-ban, the honeypot) and on guild purge. As a last
// check, settleTempBan leaves alone a ban whose latest case is newer than the row and has no duration.
// Narrow case that remains: the unban happened while Sylo was offline (the event was missed) and the
// member was then banned again natively or by another bot, which writes no Sylo case.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS temp_bans (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    mod_id     TEXT NOT NULL,
    reason     TEXT NOT NULL,
    unban_at   BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_temp_bans_due ON temp_bans (unban_at);
`);

const s = {
  upsert: prepare(`
    INSERT INTO temp_bans (guild_id, user_id, mod_id, reason, unban_at, created_at)
    VALUES (@guildId, @userId, @modId, @reason, @unbanAt, @createdAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      mod_id = excluded.mod_id,
      reason = excluded.reason,
      unban_at = excluded.unban_at,
      created_at = excluded.created_at
  `),
  get: prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?'),
  del: prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?'),
  listGuild: prepare('SELECT * FROM temp_bans WHERE guild_id = ? ORDER BY unban_at ASC'),
  due: prepare('SELECT * FROM temp_bans WHERE unban_at <= ?'),
  delGuild: prepare('DELETE FROM temp_bans WHERE guild_id = ?'),
};

/** Schedule (or reschedule) an auto-unban. */
export async function scheduleTempBan({ guildId, userId, modId, reason, unbanAt }) {
  await s.upsert.run({ guildId, userId, modId, reason, unbanAt, createdAt: Date.now() });
}

export const getTempBan = async (guildId, userId) => (await s.get.get(guildId, userId)) ?? null;
export const clearTempBan = async (guildId, userId) => (await s.del.run(guildId, userId)).changes;
export const guildTempBans = async (guildId) => s.listGuild.all(guildId);
export const dueTempBans = async (now) => s.due.all(now);
export const clearGuildTempBans = async (guildId) => s.delGuild.run(guildId);
