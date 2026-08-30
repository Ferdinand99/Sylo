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

  // Module framework: per-guild module enable state + config, and per-guild
  // command overrides (enable/disable + channel/role restrictions).
  (database) => {
    database.exec(`
      CREATE TABLE guild_modules (
        guild_id   TEXT NOT NULL,
        module_id  TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, module_id)
      );

      CREATE TABLE command_overrides (
        guild_id         TEXT NOT NULL,
        command_name     TEXT NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        allowed_channels TEXT NOT NULL DEFAULT '[]',
        allowed_roles    TEXT NOT NULL DEFAULT '[]',
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (guild_id, command_name)
      );
    `);
  },

  // Ticket / modmail system: users DM the bot, staff reply from the dashboard.
  (database) => {
    database.exec(`
      CREATE TABLE tickets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        last_at    INTEGER NOT NULL,
        closed_at  INTEGER,
        closed_by  TEXT,
        staff_seen_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_tickets_guild_status ON tickets (guild_id, status, last_at DESC);
      CREATE UNIQUE INDEX idx_tickets_open_user ON tickets (guild_id, user_id) WHERE status = 'open';

      CREATE TABLE ticket_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id   INTEGER NOT NULL,
        author_id   TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]',
        delivered   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);
    `);
  },

  // Message Creator: messages composed and sent as the bot from the dashboard.
  (database) => {
    database.exec(`
      CREATE TABLE composed_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        spec       TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_composed_guild ON composed_messages (guild_id, updated_at DESC);
    `);
  },

  // Counting mini-game: per-guild running count, record, and who counted last.
  (database) => {
    database.exec(`
      CREATE TABLE counting (
        guild_id        TEXT PRIMARY KEY,
        current         INTEGER NOT NULL DEFAULT 0,
        record          INTEGER NOT NULL DEFAULT 0,
        last_user_id    TEXT,
        last_message_id TEXT,
        updated_at      INTEGER NOT NULL
      );
    `);
  },

  // Scheduled messages: recurring posts to a channel on a fixed interval.
  (database) => {
    database.exec(`
      CREATE TABLE scheduled_messages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        channel_id       TEXT NOT NULL,
        content          TEXT NOT NULL DEFAULT '',
        interval_minutes INTEGER NOT NULL,
        next_run_at      INTEGER NOT NULL,
        last_run_at      INTEGER,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_sched_due ON scheduled_messages (enabled, next_run_at);
      CREATE INDEX idx_sched_guild ON scheduled_messages (guild_id, created_at);
    `);
  },

  // Leveling: per-member XP / level from chat activity.
  (database) => {
    database.exec(`
      CREATE TABLE leveling (
        guild_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        xp          INTEGER NOT NULL DEFAULT 0,
        level       INTEGER NOT NULL DEFAULT 0,
        messages    INTEGER NOT NULL DEFAULT 0,
        last_msg_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_leveling_rank ON leveling (guild_id, xp DESC);
    `);
  },

  // Config audit log: who changed what from the dashboard.
  (database) => {
    database.exec(`
      CREATE TABLE config_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        detail     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_config_audit_guild ON config_audit (guild_id, created_at DESC);
    `);
  },

  // Bot-wide key/value settings (e.g. the presence / activity shown in Discord).
  (database) => {
    database.exec(`
      CREATE TABLE app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
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

// Surface a corrupt database file at startup rather than mid-request.
try {
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') {
    console.error(`[db] Integrity check failed: ${check}. Restore data/ from a backup.`);
  }
} catch (err) {
  console.error('[db] Could not run integrity check:', err.message);
}

/** Close the database. Best-effort; used on shutdown paths. */
export function closeDb() {
  try {
    db.close();
  } catch {
    // Ignore — we are shutting down anyway.
  }
}
