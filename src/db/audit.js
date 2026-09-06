// Config audit log — a trail of who changed what from the dashboard.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS config_audit (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_config_audit_guild ON config_audit (guild_id, created_at DESC);
`);

const insertStmt = prepare(
  'INSERT INTO config_audit (guild_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
);
const listStmt = prepare(
  'SELECT * FROM config_audit WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
);
// Not a correlated subquery — the inner SELECT doesn't reference the outer
// query's columns, it's just the same table queried a second time in its own
// scope (picking the ids to keep), so there's no cross-scope ambiguity for
// Postgres to complain about here (unlike inviteTracker.js's `rank` query).
const pruneStmt = prepare(`
  DELETE FROM config_audit
  WHERE guild_id = ?
    AND id NOT IN (
      SELECT id FROM config_audit WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
`);

const KEEP_PER_GUILD = 500;

/**
 * @param {string} guildId
 * @param {{ actor: string, action: string, detail?: string }} entry
 */
export async function recordAudit(guildId, { actor, action, detail = '' }) {
  await insertStmt.run(
    guildId,
    String(actor).slice(0, 100),
    String(action).slice(0, 80),
    String(detail).slice(0, 500),
    Date.now()
  );
  await pruneStmt.run(guildId, guildId, KEEP_PER_GUILD);
}

export async function listAudit(guildId, limit = 100) {
  return listStmt.all(guildId, limit);
}
