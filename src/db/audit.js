// Config audit log — a trail of who changed what from the dashboard.
import { db } from './index.js';

const insertStmt = db.prepare(
  'INSERT INTO config_audit (guild_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
);
const listStmt = db.prepare(
  'SELECT * FROM config_audit WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
);
const pruneStmt = db.prepare(`
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
export function recordAudit(guildId, { actor, action, detail = '' }) {
  insertStmt.run(
    guildId,
    String(actor).slice(0, 100),
    String(action).slice(0, 80),
    String(detail).slice(0, 500),
    Date.now()
  );
  pruneStmt.run(guildId, guildId, KEEP_PER_GUILD);
}

export function listAudit(guildId, limit = 100) {
  return listStmt.all(guildId, limit);
}
