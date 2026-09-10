// Counting "bench" state: one row per (guild, user) recording an access role
// the Counting module pulled off someone for breaking the streak, and when to
// put it back. src/modules/counting.js writes the rows and sweeps `restore_at`.
// Rows are cleared on manual release, when the member leaves, and on guild purge.
//
// This is deliberately NOT a moderation feature — no ban, no timeout, no mod
// case. It only ever adds/removes the single role named in the module config.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS counting_penalties (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    restore_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_counting_penalties_due ON counting_penalties (restore_at);
`);

const s = {
  upsert: prepare(`
    INSERT INTO counting_penalties (guild_id, user_id, role_id, restore_at, created_at)
    VALUES (@guildId, @userId, @roleId, @restoreAt, @createdAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      role_id    = excluded.role_id,
      restore_at = excluded.restore_at,
      created_at = excluded.created_at
  `),
  get: prepare('SELECT * FROM counting_penalties WHERE guild_id = ? AND user_id = ?'),
  del: prepare('DELETE FROM counting_penalties WHERE guild_id = ? AND user_id = ?'),
  listGuild: prepare('SELECT * FROM counting_penalties WHERE guild_id = ? ORDER BY restore_at ASC'),
  due: prepare('SELECT * FROM counting_penalties WHERE restore_at <= ?'),
  delGuild: prepare('DELETE FROM counting_penalties WHERE guild_id = ?'),
};

/**
 * Bench a member: record which role was removed and when to restore it.
 * A second offence before the first is served just pushes `restoreAt` out.
 * @param {{ guildId: string, userId: string, roleId: string, restoreAt: number }} p
 */
export async function addCountingPenalty({ guildId, userId, roleId, restoreAt }) {
  await s.upsert.run({ guildId, userId, roleId, restoreAt, createdAt: Date.now() });
}

/** The active penalty for a member, or null. */
export async function getCountingPenalty(guildId, userId) {
  return (await s.get.get(guildId, userId)) ?? null;
}

/** Clear a member's penalty row (manual release, role restored, member left). */
export async function clearCountingPenalty(guildId, userId) {
  await s.del.run(guildId, userId);
}

/** Every active penalty in a guild, soonest-to-restore first. */
export async function listCountingPenalties(guildId) {
  return s.listGuild.all(guildId);
}

/** Penalty rows whose `restore_at` has passed — the sweep's work list. */
export async function dueCountingPenalties(now = Date.now()) {
  return s.due.all(now);
}

/** Drop every penalty row for a guild (guild purge / module data wipe). */
export async function clearGuildCountingPenalties(guildId) {
  await s.delGuild.run(guildId);
}
