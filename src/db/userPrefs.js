// Per-account dashboard-version preference (classic V1 vs the new V2 SPA).
// Keyed on the Discord user id so the choice follows the account across
// devices/browsers, not the session cookie.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id           TEXT PRIMARY KEY,
    dashboard_version TEXT NOT NULL DEFAULT 'v1',
    updated_at        BIGINT NOT NULL
  );
`);

const getStmt = prepare('SELECT dashboard_version FROM user_prefs WHERE user_id = ?');
const setStmt = prepare(`
  INSERT INTO user_prefs (user_id, dashboard_version, updated_at) VALUES (@userId, @version, @updatedAt)
  ON CONFLICT (user_id) DO UPDATE SET dashboard_version = excluded.dashboard_version, updated_at = excluded.updated_at
`);

export const DASHBOARD_VERSIONS = ['v1', 'v2'];

/** @returns {Promise<'v1'|'v2'>} */
export async function getDashboardVersion(userId) {
  const row = await getStmt.get(userId);
  return DASHBOARD_VERSIONS.includes(row?.dashboard_version) ? row.dashboard_version : 'v1';
}

/** @returns {Promise<'v1'|'v2'>} the version actually stored */
export async function setDashboardVersion(userId, version) {
  const value = DASHBOARD_VERSIONS.includes(version) ? version : 'v1';
  await setStmt.run({ userId, version: value, updatedAt: Date.now() });
  return value;
}
