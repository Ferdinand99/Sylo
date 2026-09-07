// Delete every stored row for a guild. Used when Sylo is removed from a server
// and by the /forget data-deletion command.
//
// purgeGuild/forgetUser used to run inside a db.transaction() (better-sqlite3's
// synchronous wrapper, which can't take an async callback — see the Phase 19
// note in docs/roadmap.md). Neither actually needs atomicity for correctness:
// every statement here is a DELETE (or an anonymising UPDATE) scoped to one
// guild_id / user_id pair, and deleting an already-deleted row is a no-op. If
// a purge is interrupted partway through, the remaining rows are simply
// deleted on the next attempt — self-healing, not a race. So both run as a
// plain sequence of awaited statements instead of a transaction.
import { prepare, registerPostgresBootstrap } from './driver.js';

// This file owns no table of its own — every DELETE below targets a table
// bootstrapped by its owning file, *except* the three below, which belong to
// tempVoice.js and insights.js — neither converted yet, so neither has ever
// registered Postgres DDL for them. purgeGuild deletes from every entry in
// GUILD_TABLES though, so under DATABASE_URL those DELETEs would 42P01
// against a table that was never created. Bootstrapping them here (schema
// copied verbatim from their SQLite migrations in index.js) fixes that
// without pulling either file's actual read/write logic into this phase.
// Drop this block once tempVoice.js/insights.js are converted and register
// the same DDL there instead.
registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS temp_voice_channels (
    channel_id      TEXT PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    hub_id          TEXT NOT NULL,
    owner_id        TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    locked          INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    bans            TEXT NOT NULL DEFAULT '[]',
    text_channel_id TEXT,
    empty_since     BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_temp_voice_guild ON temp_voice_channels (guild_id);

  CREATE TABLE IF NOT EXISTS guild_daily (
    guild_id             TEXT NOT NULL,
    day                  TEXT NOT NULL,
    joins                INTEGER NOT NULL DEFAULT 0,
    leaves               INTEGER NOT NULL DEFAULT 0,
    messages             INTEGER NOT NULL DEFAULT 0,
    active_members       INTEGER NOT NULL DEFAULT 0,
    channels             TEXT NOT NULL DEFAULT '{}',
    voice_minutes        INTEGER NOT NULL DEFAULT 0,
    voice_active_members INTEGER NOT NULL DEFAULT 0,
    voice_peak           INTEGER NOT NULL DEFAULT 0,
    voice_channels       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (guild_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_daily_day ON guild_daily (day);

  CREATE TABLE IF NOT EXISTS guild_hourly (
    guild_id             TEXT NOT NULL,
    hour                 TEXT NOT NULL,
    joins                INTEGER NOT NULL DEFAULT 0,
    leaves               INTEGER NOT NULL DEFAULT 0,
    messages             INTEGER NOT NULL DEFAULT 0,
    active_members       INTEGER NOT NULL DEFAULT 0,
    voice_minutes        INTEGER NOT NULL DEFAULT 0,
    voice_active_members INTEGER NOT NULL DEFAULT 0,
    voice_peak           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, hour)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_hourly_hour ON guild_hourly (hour);
`);

// Tables keyed directly by guild_id. A test in test/guildTables.test.js checks
// this stays in sync with the schema so new guild data can't escape /forget or
// the guild-leave purge.
export const GUILD_TABLES = [
  'guild_settings',
  'guild_modules',
  'command_overrides',
  'infractions',
  'case_counters',
  'tickets',
  'composed_messages',
  'counting',
  'scheduled_messages',
  'leveling',
  'leveling_periods',
  'config_audit',
  'afk',
  'posted_keys',
  'appeals',
  'temp_voice_channels',
  'starboard_posts',
  'invite_counts',
  'invite_joins',
  'invite_personal',
  'polls',
  'giveaways',
  'leaderboard_vanity',
  'temp_bans',
  'channel_locks',
  'birthdays',
  'guild_daily',
  'guild_hourly',
  'channel_cleanup_schedules',
];

const simpleStmts = GUILD_TABLES.map((t) => prepare(`DELETE FROM ${t} WHERE guild_id = ?`));
const ticketMsgStmt = prepare(
  'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ?)'
);
const giveawayEntryStmt = prepare(
  'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
);

/** Remove all of a guild's stored data. */
export async function purgeGuild(guildId) {
  await ticketMsgStmt.run(guildId); // before `tickets`, which the subquery reads
  await giveawayEntryStmt.run(guildId); // before `giveaways`, which the subquery reads
  for (const stmt of simpleStmts) await stmt.run(guildId);
}

// --- per-user erasure (for /forget) -----------------------------------------

const userStmts = {
  warnings: prepare('DELETE FROM infractions WHERE guild_id = ? AND user_id = ?'),
  leveling: prepare('DELETE FROM leveling WHERE guild_id = ? AND user_id = ?'),
  levelingPeriods: prepare('DELETE FROM leveling_periods WHERE guild_id = ? AND user_id = ?'),
  counting: prepare('UPDATE counting SET last_user_id = NULL WHERE guild_id = ? AND last_user_id = ?'),
  ticketMsgs: prepare(`
    DELETE FROM ticket_messages
    WHERE author_kind = 'user'
      AND ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)
  `),
  tickets: prepare('DELETE FROM tickets WHERE guild_id = ? AND user_id = ?'),
  appeals: prepare('DELETE FROM appeals WHERE guild_id = ? AND user_id = ?'),
  afk: prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?'),
  birthdays: prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  giveawayEntries: prepare(`
    DELETE FROM giveaway_entries
    WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)
      AND user_id = ?
  `),
  inviteCounts: prepare('DELETE FROM invite_counts WHERE guild_id = ? AND user_id = ?'),
  inviteJoins: prepare('DELETE FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  inviteJoinsAsInviter: prepare(
    "UPDATE invite_joins SET inviter_id = NULL, source = 'unknown', counted = 0 WHERE guild_id = ? AND inviter_id = ?"
  ),
  invitePersonal: prepare('DELETE FROM invite_personal WHERE guild_id = ? AND user_id = ?'),
};

/**
 * Erase a single member's data within one guild. Covers the tables that key on
 * a Discord user id; a completed giveaway's host/winner list and the config
 * audit log (which records a display name, not an id) are guild records and are
 * only removed by {@link purgeGuild}.
 * @returns {{ warnings: number, leveling: number, tickets: number, ticketMessages: number, appeals: number, afk: number, birthdays: number, giveawayEntries: number, invites: number }}
 */
export async function forgetUser(guildId, userId) {
  const warnings = (await userStmts.warnings.run(guildId, userId)).changes;
  const leveling =
    (await userStmts.leveling.run(guildId, userId)).changes +
    (await userStmts.levelingPeriods.run(guildId, userId)).changes;
  await userStmts.counting.run(guildId, userId);
  const ticketMsgs = (await userStmts.ticketMsgs.run(guildId, userId)).changes;
  const tickets = (await userStmts.tickets.run(guildId, userId)).changes;
  const appeals = (await userStmts.appeals.run(guildId, userId)).changes;
  const afk = (await userStmts.afk.run(guildId, userId)).changes;
  const birthdays = (await userStmts.birthdays.run(guildId, userId)).changes;
  const giveawayEntries = (await userStmts.giveawayEntries.run(guildId, userId)).changes;
  const invites =
    (await userStmts.inviteCounts.run(guildId, userId)).changes +
    (await userStmts.inviteJoins.run(guildId, userId)).changes +
    (await userStmts.inviteJoinsAsInviter.run(guildId, userId)).changes +
    (await userStmts.invitePersonal.run(guildId, userId)).changes;
  return {
    warnings,
    leveling,
    tickets,
    ticketMessages: ticketMsgs,
    appeals,
    afk,
    birthdays,
    giveawayEntries,
    invites,
  };
}

// --- read-only inventory ("Member data" dashboard page, /mydata export) ----

// One entry per place Sylo keys data to a Discord user id within a guild.
// describeUserData (counts, for the dashboard) and exportUserData (the rows
// themselves, for /mydata) are both built from this list, so the two can't
// drift and both stay in step with forgetUser above. `order` says how to bind
// the two placeholders: 'gu' → (guildId, userId), 'ug' → (userId, guildId).
// `invitedOthers` and `countingLast` are references that get anonymised (not
// row-deleted) but are listed so the picture is complete.
const USER_DATA_SOURCES = [
  {
    key: 'warnings',
    label: 'Moderation cases',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY case_number',
  },
  {
    key: 'leveling',
    label: 'Leveling record (XP / level / message count)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM leveling WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'levelingPeriods',
    label: 'Weekly / monthly leveling rows',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM leveling_periods WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM leveling_periods WHERE guild_id = ? AND user_id = ? ORDER BY period',
  },
  {
    key: 'tickets',
    label: 'Modmail tickets they opened',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? ORDER BY id',
  },
  {
    key: 'ticketMessages',
    label: 'Modmail messages they sent',
    order: 'gu',
    countSql:
      "SELECT COUNT(*) AS n FROM ticket_messages WHERE author_kind = 'user' AND ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)",
    rowsSql:
      "SELECT * FROM ticket_messages WHERE author_kind = 'user' AND ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?) ORDER BY id",
  },
  {
    key: 'appeals',
    label: 'Ban appeals',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM appeals WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM appeals WHERE guild_id = ? AND user_id = ? ORDER BY id',
  },
  {
    key: 'afk',
    label: 'AFK status',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM afk WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM afk WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'birthdays',
    label: 'Saved birthday',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM birthdays WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'giveawayEntries',
    label: 'Giveaway entries',
    order: 'ug',
    countSql:
      'SELECT COUNT(*) AS n FROM giveaway_entries WHERE user_id = ? AND giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)',
    rowsSql:
      'SELECT * FROM giveaway_entries WHERE user_id = ? AND giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?) ORDER BY entered_at',
  },
  {
    key: 'inviteCounts',
    label: 'Invite tally',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM invite_counts WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM invite_counts WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'inviteJoins',
    label: 'Join-via-invite record',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM invite_joins WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM invite_joins WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'invitedOthers',
    label: 'Members they are credited with inviting',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM invite_joins WHERE guild_id = ? AND inviter_id = ?',
    rowsSql: 'SELECT * FROM invite_joins WHERE guild_id = ? AND inviter_id = ? ORDER BY joined_at',
  },
  {
    key: 'invitePersonal',
    label: 'Personal invite code',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM invite_personal WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM invite_personal WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'countingLast',
    label: 'Named as the last counter',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM counting WHERE guild_id = ? AND last_user_id = ?',
    rowsSql: 'SELECT * FROM counting WHERE guild_id = ? AND last_user_id = ?',
  },
].map((s) => ({ ...s, countStmt: prepare(s.countSql), rowsStmt: prepare(s.rowsSql) }));

const bindArgs = (order, guildId, userId) => (order === 'ug' ? [userId, guildId] : [guildId, userId]);

/**
 * Count, without deleting, everything {@link forgetUser} would remove or
 * anonymise for a member in a guild.
 * @returns {{ items: Array<{ key: string, label: string, count: number }>, total: number }}
 */
export async function describeUserData(guildId, userId) {
  const items = [];
  for (const { key, label, countStmt, order } of USER_DATA_SOURCES) {
    const row = await countStmt.get(...bindArgs(order, guildId, userId));
    items.push({ key, label, count: Number(row.n) || 0 });
  }
  return { items, total: items.reduce((sum, i) => sum + i.count, 0) };
}

/**
 * The rows behind {@link describeUserData} — the data Sylo holds about a member
 * in one guild, grouped by source, for the `/mydata` self-service export. Read
 * only; nothing is deleted. Same scope as {@link forgetUser}.
 * @returns {{ generatedAt: string, guildId: string, userId: string, total: number,
 *   summary: Array<{ key: string, label: string, count: number }>,
 *   data: Record<string, object[]> }}
 */
export async function exportUserData(guildId, userId) {
  const data = {};
  const summary = [];
  for (const { key, label, rowsStmt, order } of USER_DATA_SOURCES) {
    const rows = await rowsStmt.all(...bindArgs(order, guildId, userId));
    data[key] = rows;
    summary.push({ key, label, count: rows.length });
  }
  return {
    generatedAt: new Date().toISOString(),
    guildId,
    userId,
    total: summary.reduce((sum, s) => sum + s.count, 0),
    summary,
    data,
  };
}
