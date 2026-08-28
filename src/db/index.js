// SQLite connection and schema migrations.
// The database is a single file (config.databasePath) so it can live on a
// mounted Docker volume and survive container restarts/updates.
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const dbPath = resolve(process.cwd(), config.databasePath);

// Ensure the parent directory (e.g. ./data) exists before opening the file.
mkdirSync(dirname(dbPath), { recursive: true });

/** @type {import('better-sqlite3').Database} */
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Ordered list of migrations. Each entry's index + 1 is its schema version.
 * `user_version` tracks the highest applied migration so this is idempotent
 * and safe to run on every startup.
 * @type {Array<(database: import('better-sqlite3').Database) => void>}
 */
const MIGRATIONS = [
  (database) => {
    database.exec(`
      CREATE TABLE guild_settings (
        guild_id      TEXT PRIMARY KEY,
        default_title TEXT,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE stats_cache (
        cache_key  TEXT PRIMARY KEY,
        game       TEXT NOT NULL,
        title      TEXT NOT NULL,
        username   TEXT NOT NULL,
        platform   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_stats_cache_created_at ON stats_cache (created_at DESC);
    `);
  },

  // Moderation: per-guild mod-log channel + a warnings log.
  (database) => {
    database.exec(`
      ALTER TABLE guild_settings ADD COLUMN modlog_channel_id TEXT;

      CREATE TABLE warnings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason       TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_warnings_guild_user ON warnings (guild_id, user_id);
    `);
  },
];

/**
 * Apply any migrations newer than the database's current `user_version`.
 * Runs inside a transaction per migration. Idempotent.
 */
export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const run = db.transaction(() => {
      MIGRATIONS[version](db);
      db.pragma(`user_version = ${version + 1}`);
    });
    run();
    console.log(`[db] Applied migration ${version + 1}`);
  }
}

// Run migrations as soon as the connection is opened. Modules such as
// db/cache.js prepare statements against these tables at import time, and the
// ESM import graph is evaluated before the entrypoint's body runs — so the
// schema must exist here, not later in main().
migrate();

/** Close the database. Best-effort; used on shutdown paths. */
export function closeDb() {
  try {
    db.close();
  } catch {
    // Ignore — we are shutting down anyway.
  }
}
