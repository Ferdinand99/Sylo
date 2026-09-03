// Delete every stored row for a guild. Used when Sylo is removed from a server
// and by the /forget data-deletion command.
import { db } from './index.js';

// Tables keyed directly by guild_id. A test in test/guildTables.test.js checks
// this stays in sync with the schema so new guild data can't escape /forget or
// the guild-leave purge.
export const GUILD_TABLES = [
  'guild_settings',
  'guild_modules',
  'command_overrides',
  'infractions',
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
];

const simpleStmts = GUILD_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE guild_id = ?`));
const ticketMsgStmt = db.prepare(
  'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ?)'
);
const giveawayEntryStmt = db.prepare(
  'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
);

const purgeGuildTxn = db.transaction((guildId) => {
  ticketMsgStmt.run(guildId); // before `tickets`, which the subquery reads
  giveawayEntryStmt.run(guildId); // before `giveaways`, which the subquery reads
  for (const stmt of simpleStmts) stmt.run(guildId);
});

/** Remove all of a guild's stored data. */
export function purgeGuild(guildId) {
  purgeGuildTxn(guildId);
}

// --- per-user erasure (for /forget) -----------------------------------------

const userStmts = {
  warnings: db.prepare('DELETE FROM infractions WHERE guild_id = ? AND user_id = ?'),
  leveling: db.prepare('DELETE FROM leveling WHERE guild_id = ? AND user_id = ?'),
  levelingPeriods: db.prepare('DELETE FROM leveling_periods WHERE guild_id = ? AND user_id = ?'),
  counting: db.prepare('UPDATE counting SET last_user_id = NULL WHERE guild_id = ? AND last_user_id = ?'),
  ticketMsgs: db.prepare(`
    DELETE FROM ticket_messages
    WHERE author_kind = 'user'
      AND ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)
  `),
  tickets: db.prepare('DELETE FROM tickets WHERE guild_id = ? AND user_id = ?'),
  appeals: db.prepare('DELETE FROM appeals WHERE guild_id = ? AND user_id = ?'),
  afk: db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?'),
  birthdays: db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  giveawayEntries: db.prepare(`
    DELETE FROM giveaway_entries
    WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)
      AND user_id = ?
  `),
  inviteCounts: db.prepare('DELETE FROM invite_counts WHERE guild_id = ? AND user_id = ?'),
  inviteJoins: db.prepare('DELETE FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  inviteJoinsAsInviter: db.prepare(
    "UPDATE invite_joins SET inviter_id = NULL, source = 'unknown', counted = 0 WHERE guild_id = ? AND inviter_id = ?"
  ),
  invitePersonal: db.prepare('DELETE FROM invite_personal WHERE guild_id = ? AND user_id = ?'),
};

const forgetUserTxn = db.transaction((guildId, userId) => {
  const warnings = userStmts.warnings.run(guildId, userId).changes;
  const leveling =
    userStmts.leveling.run(guildId, userId).changes + userStmts.levelingPeriods.run(guildId, userId).changes;
  userStmts.counting.run(guildId, userId);
  const ticketMsgs = userStmts.ticketMsgs.run(guildId, userId).changes;
  const tickets = userStmts.tickets.run(guildId, userId).changes;
  const appeals = userStmts.appeals.run(guildId, userId).changes;
  const afk = userStmts.afk.run(guildId, userId).changes;
  const birthdays = userStmts.birthdays.run(guildId, userId).changes;
  const giveawayEntries = userStmts.giveawayEntries.run(guildId, userId).changes;
  const invites =
    userStmts.inviteCounts.run(guildId, userId).changes +
    userStmts.inviteJoins.run(guildId, userId).changes +
    userStmts.inviteJoinsAsInviter.run(guildId, userId).changes +
    userStmts.invitePersonal.run(guildId, userId).changes;
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
});

/**
 * Erase a single member's data within one guild. Covers the tables that key on
 * a Discord user id; a completed giveaway's host/winner list and the config
 * audit log (which records a display name, not an id) are guild records and are
 * only removed by {@link purgeGuild}.
 * @returns {{ warnings: number, leveling: number, tickets: number, ticketMessages: number, appeals: number, afk: number, birthdays: number, giveawayEntries: number, invites: number }}
 */
export function forgetUser(guildId, userId) {
  return forgetUserTxn(guildId, userId);
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
].map((s) => ({ ...s, countStmt: db.prepare(s.countSql), rowsStmt: db.prepare(s.rowsSql) }));

const bindArgs = (order, guildId, userId) => (order === 'ug' ? [userId, guildId] : [guildId, userId]);

/**
 * Count, without deleting, everything {@link forgetUser} would remove or
 * anonymise for a member in a guild.
 * @returns {{ items: Array<{ key: string, label: string, count: number }>, total: number }}
 */
export function describeUserData(guildId, userId) {
  const items = USER_DATA_SOURCES.map(({ key, label, countStmt, order }) => ({
    key,
    label,
    count: countStmt.get(...bindArgs(order, guildId, userId)).n,
  }));
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
export function exportUserData(guildId, userId) {
  const data = {};
  const summary = [];
  for (const { key, label, rowsStmt, order } of USER_DATA_SOURCES) {
    const rows = rowsStmt.all(...bindArgs(order, guildId, userId));
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
