// Honeypot catch log — who triggered a honeypot and what happened to them.
// Stores the member's tag at catch time (not just their id) so the
// dashboard can show a real name even for someone who's since been
// banned/kicked and is no longer resolvable as a guild member.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS honeypot_catches (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    user_tag   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_honeypot_catches_guild ON honeypot_catches (guild_id, created_at DESC);
`);

const insertStmt = prepare(
  'INSERT INTO honeypot_catches (guild_id, user_id, user_tag, kind, channel_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const listStmt = prepare(
  'SELECT * FROM honeypot_catches WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
);
// Same prune-to-N-per-guild shape as audit.js — an append-only log needs a
// cap or it grows forever on a busy honeypot.
const pruneStmt = prepare(`
  DELETE FROM honeypot_catches
  WHERE guild_id = ?
    AND id NOT IN (
      SELECT id FROM honeypot_catches WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
`);

const KEEP_PER_GUILD = 200;

/**
 * @param {string} guildId
 * @param {{ userId: string, userTag: string, kind: 'channel'|'message', channelId: string, action: string }} entry
 */
export async function recordHoneypotCatch(guildId, { userId, userTag, kind, channelId, action }) {
  await insertStmt.run(guildId, userId, String(userTag).slice(0, 100), kind, channelId, action, Date.now());
  await pruneStmt.run(guildId, guildId, KEEP_PER_GUILD);
}

export async function recentHoneypotCatches(guildId, limit = 25) {
  return listStmt.all(guildId, limit);
}
