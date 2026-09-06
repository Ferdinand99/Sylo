// Saved state for locked channels. When /lock (or /lockdown) denies the
// message-sending permissions for @everyone, the prior @everyone overwrite is
// stored here so /unlock can restore it byte-for-byte instead of guessing.
// `lockdown = 1` marks rows created by /lockdown so `/lockdown end` finds them.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS channel_locks (
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    prev_allow    TEXT NOT NULL DEFAULT '0',
    prev_deny     TEXT NOT NULL DEFAULT '0',
    had_overwrite INTEGER NOT NULL DEFAULT 0,
    locked_by     TEXT NOT NULL,
    locked_at     BIGINT NOT NULL,
    lockdown      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, channel_id)
  );
`);

const s = {
  upsert: prepare(`
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
  get: prepare('SELECT * FROM channel_locks WHERE guild_id = ? AND channel_id = ?'),
  del: prepare('DELETE FROM channel_locks WHERE guild_id = ? AND channel_id = ?'),
  listGuild: prepare('SELECT * FROM channel_locks WHERE guild_id = ? ORDER BY locked_at ASC'),
  listLockdown: prepare('SELECT * FROM channel_locks WHERE guild_id = ? AND lockdown = 1'),
  delGuild: prepare('DELETE FROM channel_locks WHERE guild_id = ?'),
};

/**
 * Remember a channel's pre-lock @everyone overwrite. `prevAllow` / `prevDeny`
 * are permission bitfields (BigInt); they are stored as decimal strings.
 */
export async function recordChannelLock(row) {
  await s.upsert.run({
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

export const getChannelLock = async (guildId, channelId) => (await s.get.get(guildId, channelId)) ?? null;
export const isChannelLocked = async (guildId, channelId) => Boolean(await s.get.get(guildId, channelId));
export const clearChannelLock = async (guildId, channelId) => (await s.del.run(guildId, channelId)).changes;
export const guildChannelLocks = async (guildId) => s.listGuild.all(guildId);
export const lockdownChannelLocks = async (guildId) => s.listLockdown.all(guildId);
export const clearGuildChannelLocks = async (guildId) => s.delGuild.run(guildId);
