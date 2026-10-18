// The stored dev log: Sylo's own errors and warnings (src/lib/devLog.js), for the Health page in
// the Sylo app. Kept whether or not a dev-log channel is set, across restarts, and bounded: the
// newest DEV_LOG_KEEP entries from the last 30 days.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS dev_log_entries (
    id         SERIAL PRIMARY KEY,
    level      TEXT NOT NULL,
    scope      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dev_log_entries_created ON dev_log_entries (created_at DESC);
`);

export const DEV_LOG_KEEP = 500;
const KEEP_MS = 30 * 86_400_000;
const MAX_MESSAGE = 4000;
const PRUNE_EVERY = 50; // inserts between prunes

const s = {
  insert: prepare(
    'INSERT INTO dev_log_entries (level, scope, message, created_at) VALUES (@level, @scope, @message, @at)'
  ),
  list: prepare('SELECT * FROM dev_log_entries ORDER BY created_at DESC, id DESC LIMIT ?'),
  listLevel: prepare(
    'SELECT * FROM dev_log_entries WHERE level = ? ORDER BY created_at DESC, id DESC LIMIT ?'
  ),
  pruneOld: prepare('DELETE FROM dev_log_entries WHERE created_at < ?'),
  pruneCount: prepare(`
    DELETE FROM dev_log_entries WHERE id NOT IN (
      SELECT id FROM dev_log_entries ORDER BY created_at DESC, id DESC LIMIT ${DEV_LOG_KEEP}
    )
  `),
};

let sincePrune = 0;

/** Store one event. Prunes now and then, so the table stays bounded. */
export async function addDevLogEntry({ level, scope, message, at = Date.now() }) {
  await s.insert.run({
    level: level === 'warn' ? 'warn' : 'error',
    scope: String(scope ?? '').slice(0, 100),
    message: String(message ?? '').slice(0, MAX_MESSAGE),
    at,
  });
  if (++sincePrune >= PRUNE_EVERY) {
    sincePrune = 0;
    await pruneDevLog(at);
  }
}

/**
 * Newest first. `level: 'error'` for errors only.
 * @returns {Promise<Array<{ id: number, level: 'error'|'warn', scope: string, message: string, at: number }>>}
 */
export async function listDevLogEntries({ limit = 100, level } = {}) {
  const n = Math.max(1, Math.min(Math.floor(Number(limit)) || 100, DEV_LOG_KEEP));
  const rows = level === 'error' || level === 'warn' ? await s.listLevel.all(level, n) : await s.list.all(n);
  return rows.map((r) => ({
    id: Number(r.id),
    level: r.level,
    scope: r.scope,
    message: r.message,
    at: Number(r.created_at),
  }));
}

/** Drop entries older than 30 days, and all but the newest DEV_LOG_KEEP. */
export async function pruneDevLog(now = Date.now()) {
  await s.pruneOld.run(now - KEEP_MS);
  await s.pruneCount.run();
}
