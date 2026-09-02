// SQLite connection and schema migrations.
// The database is a single file (config.databasePath) so it can live on a
// mounted Docker volume and survive container restarts/updates.
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../lib/log.js';

/** Absolute path to the live SQLite file. */
export const dbPath = resolve(process.cwd(), config.databasePath);

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
export const MIGRATIONS = [
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

  // AFK: members mark themselves away; Sylo replies to anyone who mentions them.
  (database) => {
    database.exec(`
      CREATE TABLE afk (
        guild_id  TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        reason    TEXT NOT NULL DEFAULT 'AFK',
        since     INTEGER NOT NULL,
        old_nick  TEXT,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
  },

  // Free games notifier: which offers have already been announced per guild.
  (database) => {
    database.exec(`
      CREATE TABLE free_games_posted (
        guild_id  TEXT NOT NULL,
        game_key  TEXT NOT NULL,
        posted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, game_key)
      );
      CREATE INDEX idx_free_games_posted_at ON free_games_posted (posted_at);
    `);
  },

  // Ban appeals: a banned user opens a signed link, answers the guild's
  // questions, and staff accept or deny from the dashboard.
  (database) => {
    database.exec(`
      CREATE TABLE appeals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id        TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        user_tag        TEXT NOT NULL DEFAULT '',
        ban_reason      TEXT NOT NULL DEFAULT '',
        answers         TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'open',
        decided_by      TEXT,
        decision_reason TEXT,
        created_at      INTEGER NOT NULL,
        decided_at      INTEGER
      );
      CREATE INDEX idx_appeals_guild_status ON appeals (guild_id, status, created_at DESC);
      CREATE UNIQUE INDEX idx_appeals_open_user ON appeals (guild_id, user_id) WHERE status = 'open';
    `);
  },

  // Appeals: store the single-use rejoin invite generated when one is accepted,
  // so the appeal page can show it when the user reopens their link.
  (database) => {
    database.exec('ALTER TABLE appeals ADD COLUMN invite_url TEXT;');
  },

  // Temporary voice channels ("join to create"): track the channels Sylo spawns
  // so it can delete them when empty and survive a restart.
  (database) => {
    database.exec(`
      CREATE TABLE temp_voice_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        hub_id     TEXT NOT NULL,
        owner_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_temp_voice_guild ON temp_voice_channels (guild_id);
    `);
  },

  // Server Settings page: extra dashboard-admin roles ("bot masters") and a
  // default embed colour for the guild.
  (database) => {
    database.exec(`
      ALTER TABLE guild_settings ADD COLUMN bot_master_roles TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE guild_settings ADD COLUMN embed_color INTEGER;
    `);
  },

  // Starboard: which source messages have a starboard post, and their star count.
  (database) => {
    database.exec(`
      CREATE TABLE starboard_posts (
        guild_id       TEXT NOT NULL,
        board_id       TEXT NOT NULL,
        source_msg_id  TEXT NOT NULL,
        source_chan_id TEXT NOT NULL,
        post_msg_id    TEXT,
        star_count     INTEGER NOT NULL DEFAULT 0,
        posted_at      INTEGER,
        PRIMARY KEY (guild_id, board_id, source_msg_id)
      );
      CREATE INDEX idx_starboard_post ON starboard_posts (post_msg_id);
      CREATE INDEX idx_starboard_guild ON starboard_posts (guild_id, board_id);
    `);
  },

  // Invite tracker: per-member tallies and a record of who invited each joiner.
  (database) => {
    database.exec(`
      CREATE TABLE invite_counts (
        guild_id  TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        regular   INTEGER NOT NULL DEFAULT 0,
        leaves    INTEGER NOT NULL DEFAULT 0,
        bonus     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE invite_joins (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        inviter_id TEXT,
        code       TEXT,
        source     TEXT NOT NULL DEFAULT 'unknown',
        joined_at  INTEGER NOT NULL,
        counted    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (guild_id, user_id)
      );
      -- The personal invite Sylo minted for a member via /invites, so joins on
      -- that (bot-created) code are still credited to that member.
      CREATE TABLE invite_personal (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        code     TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_invite_counts_guild ON invite_counts (guild_id);
      CREATE INDEX idx_invite_personal_code ON invite_personal (guild_id, code);
    `);
  },

  // Polls: one row per active poll message, ended polls are deleted.
  (database) => {
    database.exec(`
      CREATE TABLE polls (
        message_id  TEXT PRIMARY KEY,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        question    TEXT NOT NULL,
        options     TEXT NOT NULL,
        multiple    INTEGER NOT NULL DEFAULT 0,
        max_votes   INTEGER NOT NULL DEFAULT 0,
        ends_at     INTEGER,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_polls_guild ON polls (guild_id);
      CREATE INDEX idx_polls_ends ON polls (ends_at);
    `);
  },

  // Embed messages: give each saved composition a name.
  (database) => {
    database.exec("ALTER TABLE composed_messages ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  },

  // Reminders (was "scheduled messages"): a name, an optional embed, and
  // single-vs-recurring scheduling with a start/end window and weekday filter.
  (database) => {
    database.exec(`
      ALTER TABLE scheduled_messages ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE scheduled_messages ADD COLUMN spec TEXT;
      ALTER TABLE scheduled_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'multiple';
      ALTER TABLE scheduled_messages ADD COLUMN days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6';
      ALTER TABLE scheduled_messages ADD COLUMN start_at INTEGER;
      ALTER TABLE scheduled_messages ADD COLUMN end_at INTEGER;
      ALTER TABLE scheduled_messages ADD COLUMN run_at INTEGER;
    `);
  },

  // Temporary voice channels: per-channel runtime state for the /voice-* commands.
  (database) => {
    database.exec(`
      ALTER TABLE temp_voice_channels ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE temp_voice_channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE temp_voice_channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE temp_voice_channels ADD COLUMN bans TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE temp_voice_channels ADD COLUMN text_channel_id TEXT;
      ALTER TABLE temp_voice_channels ADD COLUMN empty_since INTEGER;
    `);
  },

  // Twitch alerts: which stream we've already announced per (guild, login).
  (database) => {
    database.exec(`
      CREATE TABLE twitch_live (
        guild_id  TEXT NOT NULL,
        login     TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        posted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, login)
      );
    `);
  },

  // YouTube alerts: announced videos, and current-live state per (guild, channel).
  (database) => {
    database.exec(`
      CREATE TABLE youtube_video_seen (
        guild_id   TEXT NOT NULL,
        yt_channel TEXT NOT NULL,
        video_id   TEXT NOT NULL,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, yt_channel, video_id)
      );
      CREATE INDEX idx_yt_seen_chan ON youtube_video_seen (guild_id, yt_channel);
      CREATE TABLE youtube_live (
        guild_id   TEXT NOT NULL,
        yt_channel TEXT NOT NULL,
        video_id   TEXT NOT NULL,
        posted_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, yt_channel)
      );
    `);
  },

  // Giveaways: one row per giveaway plus a row per entrant.
  (database) => {
    database.exec(`
      CREATE TABLE giveaways (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        channel_id       TEXT NOT NULL,
        message_id       TEXT,
        prize            TEXT NOT NULL,
        winners          INTEGER NOT NULL DEFAULT 1,
        host_id          TEXT NOT NULL,
        required_role_id TEXT,
        ends_at          INTEGER NOT NULL,
        ended            INTEGER NOT NULL DEFAULT 0,
        won_ids          TEXT NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_giveaways_guild ON giveaways (guild_id, ended, ends_at);
      CREATE TABLE giveaway_entries (
        giveaway_id INTEGER NOT NULL,
        user_id     TEXT NOT NULL,
        entered_at  INTEGER NOT NULL,
        PRIMARY KEY (giveaway_id, user_id)
      );
    `);
  },

  // 3.0: the "Reminders" module's stable id changes from the legacy
  // "scheduled-messages" to "reminders" (the name shown in the UI all along).
  (database) => {
    database
      .prepare("UPDATE guild_modules SET module_id = 'reminders' WHERE module_id = 'scheduled-messages'")
      .run();
  },

  // Vanity URL for a guild's public leaderboard (MEE6-style short link).
  (database) => {
    database.exec(`
      CREATE TABLE leaderboard_vanity (
        guild_id   TEXT PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL
      );
    `);
  },

  // 3.4: temporary bans that auto-expire, and saved channel-lock state so
  // /unlock restores the exact prior @everyone overwrite (not just "allow").
  (database) => {
    database.exec(`
      CREATE TABLE temp_bans (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        mod_id     TEXT NOT NULL,
        reason     TEXT NOT NULL,
        unban_at   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_temp_bans_due ON temp_bans (unban_at);

      CREATE TABLE channel_locks (
        guild_id      TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        prev_allow    TEXT NOT NULL DEFAULT '0',
        prev_deny     TEXT NOT NULL DEFAULT '0',
        had_overwrite INTEGER NOT NULL DEFAULT 0,
        locked_by     TEXT NOT NULL,
        locked_at     INTEGER NOT NULL,
        lockdown      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, channel_id)
      );
    `);
  },

  // 3.5: Birthdays module — one row per member per guild.
  (database) => {
    database.exec(`
      CREATE TABLE birthdays (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        month      INTEGER NOT NULL,
        day        INTEGER NOT NULL,
        year       INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_birthdays_md ON birthdays (month, day);
    `);
  },

  // 3.9: fold the scattered "have we posted this already" tables
  // (free_games_posted, twitch_live, youtube_live, youtube_video_seen) into one
  // generic posted_keys table, keyed by (guild_id, scope, key) with an optional
  // value (e.g. the announced stream/video id). Starboard keeps its own table —
  // it stores mutable state (star counts, the posted message id), not just a key.
  (database) => {
    database.exec(`
      CREATE TABLE posted_keys (
        guild_id  TEXT NOT NULL,
        scope     TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT,
        posted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, scope, key)
      );
      CREATE INDEX idx_posted_keys_prune ON posted_keys (scope, posted_at);

      INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
        SELECT guild_id, 'free-games', game_key, NULL, posted_at FROM free_games_posted;
      INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
        SELECT guild_id, 'twitch', login, stream_id, posted_at FROM twitch_live;
      INSERT INTO posted_keys (guild_id, scope, key, value, posted_at)
        SELECT guild_id, 'yt-live', yt_channel, video_id, posted_at FROM youtube_live;
      INSERT OR IGNORE INTO posted_keys (guild_id, scope, key, value, posted_at)
        SELECT guild_id, 'yt-video', yt_channel || ':' || video_id, NULL, seen_at FROM youtube_video_seen;

      DROP TABLE free_games_posted;
      DROP TABLE twitch_live;
      DROP TABLE youtube_live;
      DROP TABLE youtube_video_seen;
    `);
  },

  // 3.11: Server insights — one aggregate row per guild per UTC day. `channels`
  // is a JSON map of channelId -> message count for that day (for the "top
  // channels" chart). Populated only while the `insights` module is enabled.
  (database) => {
    database.exec(`
      CREATE TABLE guild_daily (
        guild_id       TEXT NOT NULL,
        day            TEXT NOT NULL,
        joins          INTEGER NOT NULL DEFAULT 0,
        leaves         INTEGER NOT NULL DEFAULT 0,
        messages       INTEGER NOT NULL DEFAULT 0,
        active_members INTEGER NOT NULL DEFAULT 0,
        channels       TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (guild_id, day)
      );
      CREATE INDEX idx_guild_daily_day ON guild_daily (day);
    `);
  },
];

/** Highest schema version this build knows how to run. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Timestamp slug for backup filenames, e.g. "2026-09-01-14-30-05-123" (ms keeps it unique). */
export function fileStamp(d = new Date()) {
  return d.toISOString().slice(0, 23).replace(/[:T.]/g, '-');
}

/** Force a WAL checkpoint, truncating the -wal sidecar. Best-effort. */
export function checkpoint() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log.error('db', 'WAL checkpoint failed:', err.message);
  }
}

/** Write a compacted single-file snapshot of the database to destPath (sync). */
export function vacuumInto(destPath) {
  db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
}

/** Snapshot the DB before a schema change so an aborted migration is recoverable. */
function preMigrationBackup(fromVersion) {
  try {
    const dir = config.backupDir
      ? resolve(process.cwd(), config.backupDir)
      : resolve(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    const dest = resolve(dir, `sylo-premigrate-v${fromVersion}-${fileStamp()}.db`);
    vacuumInto(dest);
    log.info('db', `Pre-migration backup written: ${dest}`);
  } catch (err) {
    log.error('db', 'Pre-migration backup failed (continuing):', err.message);
  }
}

/**
 * Apply any migrations newer than the database's current `user_version`.
 * Runs inside a transaction per migration. Idempotent.
 */
export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  // Only when there is existing data to protect — a brand-new DB has none.
  if (current > 0 && current < MIGRATIONS.length) preMigrationBackup(current);
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const run = db.transaction(() => {
      MIGRATIONS[version](db);
      db.pragma(`user_version = ${version + 1}`);
    });
    run();
    log.info('db', `Applied migration ${version + 1}`);
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
    log.error('db', `Integrity check failed: ${check}. Restore data/ from a backup.`);
  }
} catch (err) {
  log.error('db', 'Could not run integrity check:', err.message);
}

/** Close the database. Best-effort; used on shutdown paths. */
export function closeDb() {
  try {
    checkpoint();
    db.close();
  } catch {
    // Ignore — we are shutting down anyway.
  }
}
