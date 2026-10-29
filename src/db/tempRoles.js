// Temporary roles storage: one row per (server, member, role) that Sylo has to take back later.
//
//   expires_at  epoch ms; the sweep in modules/tempRoles.js removes the role once it has passed
//   added_by    the staff member who set it; NULL after that person used /forget
//   reason      free text from the staff member ('' when none)
//
// Adding the same member and role again replaces the row (the new expiry wins).
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_temp_roles (
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role_id     TEXT NOT NULL,
    expires_at  BIGINT NOT NULL,
    added_by    TEXT,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_temp_roles_expires ON guild_temp_roles (expires_at);
  CREATE INDEX IF NOT EXISTS idx_guild_temp_roles_user ON guild_temp_roles (user_id);
`);

const s = {
  upsert: prepare(`
    INSERT INTO guild_temp_roles (guild_id, user_id, role_id, expires_at, added_by, reason, created_at)
    VALUES (@guildId, @userId, @roleId, @expiresAt, @addedBy, @reason, @createdAt)
    ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET
      expires_at = excluded.expires_at,
      added_by = excluded.added_by,
      reason = excluded.reason,
      created_at = excluded.created_at
  `),
  get: prepare('SELECT * FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'),
  del: prepare('DELETE FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'),
  // Only the row as it was read: an extension that landed meanwhile must survive.
  delAt: prepare(
    'DELETE FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ? AND expires_at = ?'
  ),
  delUser: prepare('DELETE FROM guild_temp_roles WHERE guild_id = ? AND user_id = ?'),
  delGuild: prepare('DELETE FROM guild_temp_roles WHERE guild_id = ?'),
  count: prepare('SELECT COUNT(*) AS n FROM guild_temp_roles WHERE guild_id = ?'),
  list: prepare(
    'SELECT * FROM guild_temp_roles WHERE guild_id = ? ORDER BY expires_at, user_id, role_id LIMIT ?'
  ),
  listUser: prepare(
    'SELECT * FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? ORDER BY expires_at, role_id LIMIT ?'
  ),
  due: prepare('SELECT * FROM guild_temp_roles WHERE expires_at <= ? ORDER BY expires_at LIMIT ?'),
  next: prepare('SELECT MIN(expires_at) AS t FROM guild_temp_roles WHERE guild_id = ?'),
};

// Postgres hands BIGINT back as text on some paths; downstream treats them as numbers.
const hydrate = (row) =>
  row ? { ...row, expires_at: Number(row.expires_at), created_at: Number(row.created_at) } : null;

/**
 * Store a temporary role, replacing an earlier one for the same member and role.
 * @param {{ guildId: string, userId: string, roleId: string, expiresAt: number, addedBy?: string|null,
 *   reason?: string, createdAt?: number }} e
 */
export const putTempRole = async (e) =>
  s.upsert.run({
    guildId: e.guildId,
    userId: e.userId,
    roleId: e.roleId,
    expiresAt: e.expiresAt,
    addedBy: e.addedBy ?? null,
    reason: e.reason ?? '',
    createdAt: e.createdAt ?? Date.now(),
  });

export const getTempRole = async (guildId, userId, roleId) =>
  hydrate(await s.get.get(guildId, userId, roleId));

/** @returns {Promise<boolean>} whether a row was removed */
export const deleteTempRole = async (guildId, userId, roleId) =>
  (await s.del.run(guildId, userId, roleId)).changes > 0;

/** Remove the row only if it still expires at `expiresAt` (it was not extended meanwhile). */
export const deleteTempRoleAt = async (guildId, userId, roleId, expiresAt) =>
  (await s.delAt.run(guildId, userId, roleId, expiresAt)).changes > 0;

/** Every temporary role of a member in a server (they left: nothing is left to take back). */
export const deleteTempRolesOfUser = async (guildId, userId) =>
  (await s.delUser.run(guildId, userId)).changes;

export const tempRoleCount = async (guildId) => Number((await s.count.get(guildId))?.n) || 0;

/** A server's temporary roles, soonest expiry first. */
export async function listTempRoles(guildId, { userId = null, limit = 2000 } = {}) {
  const rows = userId ? await s.listUser.all(guildId, userId, limit) : await s.list.all(guildId, limit);
  return rows.map(hydrate);
}

/** When the next temporary role of a server runs out (epoch ms), or null. */
export async function nextTempRoleExpiry(guildId) {
  const t = (await s.next.get(guildId))?.t;
  return t == null ? null : Number(t);
}

/** Rows of every server whose time has come, oldest first. */
export async function dueTempRoles(now = Date.now(), limit = 200) {
  return (await s.due.all(now, limit)).map(hydrate);
}

export async function clearGuildTempRoles(guildId) {
  await s.delGuild.run(guildId);
}
