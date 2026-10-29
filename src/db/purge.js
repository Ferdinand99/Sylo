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
import { prepare } from './driver.js';

// This file owns no table of its own — every DELETE below targets a table
// bootstrapped by its owning file. But `registerPostgresBootstrap()` only
// runs when that owning file is actually imported somewhere in *this*
// process, and under `node --test` every test file is its own process — so a
// process that imports purge.js without also (directly or transitively)
// importing, say, starboard.js would 42P01 on `DELETE FROM starboard_posts`,
// purely depending on which test files happened to run in which process.
// Import every owning file below for its bootstrap side effect alone (all
// their actual exports go unused here) so purgeGuild's full table list is
// always backed by real DDL in whichever process loads purge.js, test or
// production. Harmless and cheap — these are plain data modules with no
// other side effects at import time.
import './guildSettings.js';
import './modules.js';
import './commandOverrides.js';
import './modCases.js';
import './tickets.js';
import './composedMessages.js';
import './counting.js';
import './countingPenalties.js';
import './githubWatches.js';
import './scheduledMessages.js';
import './leveling.js';
import './audit.js';
import './afk.js';
import './postedKeys.js';
import './appeals.js';
import './tempVoice.js';
import './starboard.js';
import './inviteTracker.js';
import './polls.js';
import './giveaways.js';
import './leaderboardVanity.js';
import './tempBans.js';
import './channelLocks.js';
import './birthdays.js';
import './insights.js';
import './channelCleanup.js';
import './honeypotCatches.js';
import './componentReactions.js';
import './verificationKicks.js';
import './events.js';
import './suggestions.js';

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
  'counting_penalties',
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
  'github_watches',
  'honeypot_catches',
  'component_reactions',
  'verification_kicks',
  'guild_events',
  'guild_suggestions',
];

const simpleStmts = GUILD_TABLES.map((t) => prepare(`DELETE FROM ${t} WHERE guild_id = ?`));
const ticketMsgStmt = prepare(
  'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ?)'
);
const giveawayEntryStmt = prepare(
  'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
);
const eventParticipantStmt = prepare(
  'DELETE FROM guild_event_participants WHERE event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)'
);

const suggestionVoteStmt = prepare(
  'DELETE FROM guild_suggestion_votes WHERE suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = ?)'
);

/** Remove all of a guild's stored data. */
export async function purgeGuild(guildId) {
  await ticketMsgStmt.run(guildId); // before `tickets`, which the subquery reads
  await giveawayEntryStmt.run(guildId); // before `giveaways`, which the subquery reads
  await eventParticipantStmt.run(guildId); // before `guild_events`, which the subquery reads
  await suggestionVoteStmt.run(guildId); // before `guild_suggestions`, which the subquery reads
  for (const stmt of simpleStmts) await stmt.run(guildId);
}

// --- per-user erasure (for /forget) -----------------------------------------

const userStmts = {
  keptCases: prepare('SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ?'),
  leveling: prepare('DELETE FROM leveling WHERE guild_id = ? AND user_id = ?'),
  levelingPeriods: prepare('DELETE FROM leveling_periods WHERE guild_id = ? AND user_id = ?'),
  counting: prepare('UPDATE counting SET last_user_id = NULL WHERE guild_id = ? AND last_user_id = ?'),
  // Every message in the member's tickets, staff replies too: they go with the ticket (and
  // often quote the member). Left behind, they could never be found again by any purge.
  ticketMsgs: prepare(`
    DELETE FROM ticket_messages
    WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)
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
  eventParticipants: prepare(`
    DELETE FROM guild_event_participants
    WHERE event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)
      AND user_id = ?
  `),
  suggestionVotes: prepare(`
    DELETE FROM guild_suggestion_votes
    WHERE suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = ?)
      AND user_id = ?
  `),
  // The suggestion text stays so the server keeps its board; only the person is taken off it.
  suggestionAuthor: prepare(
    'UPDATE guild_suggestions SET author_id = NULL WHERE guild_id = ? AND author_id = ?'
  ),
  suggestionDecider: prepare(
    'UPDATE guild_suggestions SET decided_by = NULL WHERE guild_id = ? AND decided_by = ?'
  ),
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
 *
 * Safety records are kept: moderation cases (warnings, kicks, bans, notes), temp bans,
 * honeypot catches and counting penalties. They exist to protect the server, so a member
 * cannot erase them (or reset their warning count) with /forget; staff can remove a case in
 * the dashboard. `keptCases` says how many cases stayed.
 * @returns {{ keptCases: number, leveling: number, tickets: number, ticketMessages: number, appeals: number, afk: number, birthdays: number, giveawayEntries: number, eventSignups: number, suggestionVotes: number, suggestions: number, suggestionDecisions: number, invites: number }}
 */
export async function forgetUser(guildId, userId) {
  const keptCases = Number((await userStmts.keptCases.get(guildId, userId)).n) || 0;
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
  const eventSignups = (await userStmts.eventParticipants.run(guildId, userId)).changes;
  const suggestionVotes = (await userStmts.suggestionVotes.run(guildId, userId)).changes;
  const suggestions = (await userStmts.suggestionAuthor.run(guildId, userId)).changes;
  const suggestionDecisions = (await userStmts.suggestionDecider.run(guildId, userId)).changes;
  const invites =
    (await userStmts.inviteCounts.run(guildId, userId)).changes +
    (await userStmts.inviteJoins.run(guildId, userId)).changes +
    (await userStmts.inviteJoinsAsInviter.run(guildId, userId)).changes +
    (await userStmts.invitePersonal.run(guildId, userId)).changes;
  return {
    keptCases,
    leveling,
    tickets,
    ticketMessages: ticketMsgs,
    appeals,
    afk,
    birthdays,
    giveawayEntries,
    eventSignups,
    suggestionVotes,
    suggestions,
    suggestionDecisions,
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
    label: 'Moderation cases (kept by /forget)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ?',
    // Not moderator_id: who took the action is the moderator's data, not the member's.
    rowsSql:
      'SELECT guild_id, case_number, user_id, action, reason, detail, active, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY case_number',
  },
  {
    key: 'tempBans',
    label: 'Temporary ban (kept by /forget)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM temp_bans WHERE guild_id = ? AND user_id = ?',
    rowsSql:
      'SELECT guild_id, user_id, reason, unban_at, created_at FROM temp_bans WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'honeypotCatches',
    label: 'Honeypot catches (kept by /forget)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM honeypot_catches WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM honeypot_catches WHERE guild_id = ? AND user_id = ? ORDER BY created_at',
  },
  {
    key: 'countingPenalties',
    label: 'Counting penalty (kept by /forget)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM counting_penalties WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM counting_penalties WHERE guild_id = ? AND user_id = ?',
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
    label: 'Messages in their modmail tickets',
    order: 'gu',
    countSql:
      'SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)',
    // Staff replies are part of the member's conversation, but not who on the staff wrote them.
    rowsSql:
      "SELECT id, ticket_id, CASE WHEN author_kind = 'user' THEN author_id ELSE NULL END AS author_id, author_kind, content, attachments, created_at FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?) ORDER BY id",
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
    key: 'eventSignups',
    label: 'Event sign-ups (Join / Maybe)',
    order: 'ug',
    countSql:
      'SELECT COUNT(*) AS n FROM guild_event_participants WHERE user_id = ? AND event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)',
    rowsSql:
      'SELECT * FROM guild_event_participants WHERE user_id = ? AND event_id IN (SELECT id FROM guild_events WHERE guild_id = ?) ORDER BY updated_at',
  },
  {
    key: 'suggestionVotes',
    label: 'Suggestion votes (up / down)',
    order: 'ug',
    countSql:
      'SELECT COUNT(*) AS n FROM guild_suggestion_votes WHERE user_id = ? AND suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = ?)',
    rowsSql:
      'SELECT * FROM guild_suggestion_votes WHERE user_id = ? AND suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = ?) ORDER BY updated_at',
  },
  {
    key: 'suggestions',
    label: 'Suggestions they wrote (/forget keeps the text, drops you as the author)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_suggestions WHERE guild_id = ? AND author_id = ?',
    rowsSql: 'SELECT * FROM guild_suggestions WHERE guild_id = ? AND author_id = ? ORDER BY number',
  },
  {
    key: 'suggestionDecisions',
    label: 'Suggestions they decided as staff (/forget drops the name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_suggestions WHERE guild_id = ? AND decided_by = ?',
    rowsSql:
      'SELECT number, status, reason, decided_at FROM guild_suggestions WHERE guild_id = ? AND decided_by = ? ORDER BY number',
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
    // When and how, not who: the members they invited are other people.
    rowsSql:
      'SELECT source, joined_at, counted FROM invite_joins WHERE guild_id = ? AND inviter_id = ? ORDER BY joined_at',
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
  for (const { key, label, countStmt, order, kept = false } of USER_DATA_SOURCES) {
    const row = await countStmt.get(...bindArgs(order, guildId, userId));
    items.push({ key, label, count: Number(row.n) || 0, kept });
  }
  return {
    items,
    total: items.reduce((sum, i) => sum + i.count, 0),
    // What forgetUser removes or anonymises; the rest are kept safety records.
    erasable: items.filter((i) => !i.kept).reduce((sum, i) => sum + i.count, 0),
  };
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
