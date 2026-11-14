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
// One page, newest first: `before` is the id of the last row of the previous page (0 = from the top). The
// order is the id's too, the same thing the cursor compares, so a page never skips or repeats a row.
const pageStmt = prepare('SELECT * FROM config_audit WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?');
const pageByActionStmt = prepare(
  'SELECT * FROM config_audit WHERE guild_id = ? AND action = ? AND id < ? ORDER BY id DESC LIMIT ?'
);
const actionsStmt = prepare(
  'SELECT action, COUNT(*) AS n FROM config_audit WHERE guild_id = ? GROUP BY action ORDER BY n DESC, action'
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

const MAX_PAGE = 100;
// The id column is a 32-bit integer on Postgres: "from the top" is the largest value it holds.
const MAX_ID = 2147483647;

/**
 * A page of one server's audit rows, newest first, optionally only one action.
 * `before` is the id of the last row already shown (rows with a lower id follow). One extra row is read
 * to tell whether there is more.
 * @param {string} guildId
 * @param {{ limit?: number, before?: number, action?: string }} [opts]
 * @returns {Promise<{ rows: any[], hasMore: boolean }>}
 */
export async function listAuditPage(guildId, { limit = 50, before = 0, action = '' } = {}) {
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), MAX_PAGE);
  const from =
    Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Math.min(Number(before), MAX_ID) : MAX_ID;
  const rows = action
    ? await pageByActionStmt.all(guildId, String(action).slice(0, 80), from, size + 1)
    : await pageStmt.all(guildId, from, size + 1);
  return { rows: rows.slice(0, size), hasMore: rows.length > size };
}

/** The kinds of change recorded for a server, with how many of each (most frequent first). */
export async function listAuditActions(guildId) {
  return (await actionsStmt.all(guildId)).map((r) => ({ action: r.action, count: Number(r.n) }));
}
