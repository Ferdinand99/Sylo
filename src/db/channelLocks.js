// Saved state for locked channels. When /lock (or /lockdown) denies the
// message-sending permissions for @everyone, the prior @everyone overwrite is
// stored here so /unlock can restore it byte-for-byte instead of guessing.
// `lockdown = 1` marks rows created by /lockdown so `/lockdown end` finds them.
import { db } from './index.js';

const s = {
  upsert: db.prepare(`
    INSERT INTO channel_locks
      (guild_id, channel_id, prev_allow, prev_deny, had_overwrite, locked_by, locked_at, lockdown)
    VALUES
      (@guildId, @channelId, @prevAllow, @prevDeny, @hadOverwrite, @lockedBy, @lockedAt, @lockdown)
    ON CONFLICT (guild_id, channel_id) DO UPDATE SET
      prev_allow = excluded.prev_allow,
      prev_deny = excluded.prev_deny,
      had_overwrite = excluded.had_overwrite,
      locked_by = excluded.locked_by,
      locked_at = excluded.locked_at,
      lockdown = excluded.lockdown
  `),
  get: db.prepare('SELECT * FROM channel_locks WHERE guild_id = ? AND channel_id = ?'),
  del: db.prepare('DELETE FROM channel_locks WHERE guild_id = ? AND channel_id = ?'),
  listGuild: db.prepare('SELECT * FROM channel_locks WHERE guild_id = ? ORDER BY locked_at ASC'),
  listLockdown: db.prepare('SELECT * FROM channel_locks WHERE guild_id = ? AND lockdown = 1'),
  delGuild: db.prepare('DELETE FROM channel_locks WHERE guild_id = ?'),
};

/**
 * Remember a channel's pre-lock @everyone overwrite. `prevAllow` / `prevDeny`
 * are permission bitfields (BigInt); they are stored as decimal strings.
 */
export function recordChannelLock(row) {
  s.upsert.run({
    guildId: row.guildId,
    channelId: row.channelId,
    prevAllow: String(row.prevAllow ?? 0n),
    prevDeny: String(row.prevDeny ?? 0n),
    hadOverwrite: row.hadOverwrite ? 1 : 0,
    lockedBy: row.lockedBy,
    lockedAt: Date.now(),
    lockdown: row.lockdown ? 1 : 0,
  });
}

export const getChannelLock = (guildId, channelId) => s.get.get(guildId, channelId) ?? null;
export const isChannelLocked = (guildId, channelId) => Boolean(s.get.get(guildId, channelId));
export const clearChannelLock = (guildId, channelId) => s.del.run(guildId, channelId).changes;
export const guildChannelLocks = (guildId) => s.listGuild.all(guildId);
export const lockdownChannelLocks = (guildId) => s.listLockdown.all(guildId);
export const clearGuildChannelLocks = (guildId) => s.delGuild.run(guildId);
