// Bot-wide audit log — who changed bot-level (not per-guild) settings from
// the dashboard: identity/avatar/banner, presence, the announcement banner.
// Mirrors src/db/audit.js's per-guild config_audit exactly, minus guild_id.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS bot_audit (
    id         SERIAL PRIMARY KEY,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bot_audit_created ON bot_audit (created_at DESC);
`);

const insertStmt = prepare('INSERT INTO bot_audit (actor, action, detail, created_at) VALUES (?, ?, ?, ?)');
const listStmt = prepare('SELECT * FROM bot_audit ORDER BY created_at DESC, id DESC LIMIT ?');
const pruneStmt = prepare(`
  DELETE FROM bot_audit
  WHERE id NOT IN (SELECT id FROM bot_audit ORDER BY created_at DESC, id DESC LIMIT ?)
`);

const KEEP = 500;

/**
 * @param {{ actor: string, action: string, detail?: string }} entry
 */
export async function recordBotAudit({ actor, action, detail = '' }) {
  await insertStmt.run(
    String(actor).slice(0, 100),
    String(action).slice(0, 80),
    String(detail).slice(0, 500),
    Date.now()
  );
  await pruneStmt.run(KEEP);
}

export async function listBotAudit(limit = 200) {
  return listStmt.all(limit);
}
