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
import { clearCommandPrefixCache } from './guildSettings.js';
import { eraseMember } from './economy.js';
import { eraseInventory } from './economyShop.js';
import { removeGuildImages } from '../lib/collectibleFiles.js';

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
import './tempRoles.js';
import './quotes.js';
import './introductions.js';
import './welcomeSent.js';
import './applications.js';
import './economy.js';
import './economyShop.js';

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
  'guild_suggestion_counters',
  'guild_temp_roles',
  'guild_quotes',
  'guild_quote_counters',
  'introductions',
  'welcome_sent',
  'applications_forms',
  'applications_submissions',
  'applications_cooldowns',
  'economy_accounts',
  'economy_transactions',
  'economy_cooldowns',
  'economy_items',
  'economy_inventory',
];

const simpleStmts = GUILD_TABLES.map((t) => prepare(`DELETE FROM ${t} WHERE guild_id = ?`));
const ticketMsgStmt = prepare(
  'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ?)'
);
const giveawayEntryStmt = prepare(
  'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
);
const giveawayPrizeStmt = prepare(
  'DELETE FROM giveaway_prizes WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
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
  await giveawayPrizeStmt.run(guildId);
  await eventParticipantStmt.run(guildId); // before `guild_events`, which the subquery reads
  await suggestionVoteStmt.run(guildId); // before `guild_suggestions`, which the subquery reads
  for (const stmt of simpleStmts) await stmt.run(guildId);
  // The pictures of the server's collectibles are files, not rows: they go with the rest of its data.
  await removeGuildImages(guildId);
  clearCommandPrefixCache(guildId);
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
  // Kept on purpose, like the economy cooldown record: the row (giveaway id and member id, nothing
  // else) is what stops a prize being paid a second time to a member who ran /forget. The amount and
  // the time come off. The rows go with the giveaway when the server is purged.
  giveawayPrizes: prepare(`
    UPDATE giveaway_prizes SET amount = 0, paid_at = 0
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
  // The event stays (it may still be upcoming); only the host's id comes off it.
  eventHost: prepare('UPDATE guild_events SET host_id = NULL WHERE guild_id = ? AND host_id = ?'),
  // Their roles stay on the platform; only the record that Sylo would take them back is dropped.
  tempRoles: prepare('DELETE FROM guild_temp_roles WHERE guild_id = ? AND user_id = ?'),
  tempRoleAdder: prepare('UPDATE guild_temp_roles SET added_by = NULL WHERE guild_id = ? AND added_by = ?'),
  // A quote is the author's words, so it goes with them (the number stays used: the counter is not
  // touched). A quote someone else wrote stays on the board; only the saver's name comes off it.
  quotesAuthored: prepare('DELETE FROM guild_quotes WHERE guild_id = ? AND author_id = ?'),
  quotesSaved: prepare('UPDATE guild_quotes SET saved_by = NULL WHERE guild_id = ? AND saved_by = ?'),
  // Their introduction: the answers and the row that points at the card message. The message itself
  // is deleted by the callers that hold the guild (forgetIntroductionCard in modules/introductions.js).
  introductions: prepare('DELETE FROM introductions WHERE guild_id = ? AND user_id = ?'),
  // Their applications: the answers and the row. The posts are deleted first by the callers that hold
  // the guild (forgetApplicationPosts in modules/applications.js). The cooldown after a denial is kept on
  // purpose, like the economy's: otherwise /forget would be a way around it.
  applications: prepare('DELETE FROM applications_submissions WHERE guild_id = ? AND user_id = ?'),
  applicationsDecider: prepare(
    'UPDATE applications_submissions SET decided_by = NULL WHERE guild_id = ? AND decided_by = ?'
  ),
  // The record that they were welcomed, on joining or on a role gain (modules/welcome.js): only the time.
  // It is deleted like the rest of their data, so a later role gain can welcome them again.
  welcomeSent: prepare('DELETE FROM welcome_sent WHERE guild_id = ? AND user_id = ?'),
  introductionsClear: prepare(
    "UPDATE introductions SET answers = '{}', updated_at = ? WHERE guild_id = ? AND user_id = ?"
  ),
  inviteCounts: prepare('DELETE FROM invite_counts WHERE guild_id = ? AND user_id = ?'),
  inviteJoins: prepare('DELETE FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  inviteJoinsAsInviter: prepare(
    "UPDATE invite_joins SET inviter_id = NULL, source = 'unknown', counted = 0 WHERE guild_id = ? AND inviter_id = ?"
  ),
  invitePersonal: prepare('DELETE FROM invite_personal WHERE guild_id = ? AND user_id = ?'),
  // The poll or giveaway stays (it may still be running); only the maker's id comes off it. The
  // columns are NOT NULL, so an empty string stands for "nobody".
  pollsCreated: prepare("UPDATE polls SET created_by = '' WHERE guild_id = ? AND created_by = ?"),
  giveawaysHosted: prepare("UPDATE giveaways SET host_id = '' WHERE guild_id = ? AND host_id = ?"),
  // A temporary voice channel they own keeps existing; it just has no owner now (the next member
  // to be in it takes over, as when an owner leaves).
  tempVoiceOwned: prepare("UPDATE temp_voice_channels SET owner_id = '' WHERE guild_id = ? AND owner_id = ?"),
  verificationKicks: prepare('DELETE FROM verification_kicks WHERE guild_id = ? AND user_id = ?'),
  // Staff side: who closed someone's ticket or decided someone's appeal. The ticket and the
  // appeal stay with their owner; only the staff member's id comes off.
  ticketsClosed: prepare('UPDATE tickets SET closed_by = NULL WHERE guild_id = ? AND closed_by = ?'),
  appealsDecided: prepare('UPDATE appeals SET decided_by = NULL WHERE guild_id = ? AND decided_by = ?'),
};

/**
 * Erase a single member's data within one guild. Covers the tables that key on
 * a Discord user id. A completed giveaway's winner list and the config audit log (which
 * records a display name, not an id) are guild records, only removed by {@link purgeGuild};
 * so is `infractions.moderator_id`, the staff side of a moderation case (the cases are kept).
 * test/purge.test.js lists every column that holds a user id and fails for a new one that
 * is neither handled here nor kept on purpose.
 *
 * Safety records are kept: moderation cases (warnings, kicks, bans, notes), temp bans,
 * honeypot catches and counting penalties. They exist to protect the server, so a member
 * cannot erase them (or reset their warning count) with /forget; staff can remove a case in
 * the dashboard. `keptCases` says how many cases stayed.
 * @returns {{ keptCases: number, leveling: number, tickets: number, ticketMessages: number, appeals: number, afk: number, birthdays: number, giveawayEntries: number, eventSignups: number, eventsHosted: number, suggestionVotes: number, suggestions: number, suggestionDecisions: number, tempRoles: number, tempRoleAdders: number, quotes: number, quotesSaved: number, introductions: number, welcomeSent: number, applications: number, applicationsDecided: number, economyAccounts: number, economyTransactions: number, economyNames: number, economyInventory: number, economyFulfilled: number, invites: number, pollsCreated: number, giveawaysHosted: number, tempVoiceOwned: number, verificationKicks: number, ticketsClosed: number, appealsDecided: number }}
 */
// `keepIntroduction`: leave the introduction row (the card message could not be deleted, so the row
// is what lets it be removed later). `keepTempRoles`: role ids whose temporary-role record stays
// because Sylo could not take the role off (the callers take a bought role off first, see
// endShopRolesForForget in modules/lib/shop.js): the expiry sweep still removes it on time.
// `keepApplicationIds`: submissions whose post could not be deleted. Their rows stay without the answers
// (the ids are what lets the post be deleted later); every other submission of the member is deleted.
export async function forgetUser(
  guildId,
  userId,
  { keepIntroduction = false, keepTempRoles = [], keepApplicationIds = [] } = {}
) {
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
  await userStmts.giveawayPrizes.run(guildId, userId);
  const eventSignups = (await userStmts.eventParticipants.run(guildId, userId)).changes;
  const eventsHosted = (await userStmts.eventHost.run(guildId, userId)).changes;
  const suggestionVotes = (await userStmts.suggestionVotes.run(guildId, userId)).changes;
  const suggestions = (await userStmts.suggestionAuthor.run(guildId, userId)).changes;
  const suggestionDecisions = (await userStmts.suggestionDecider.run(guildId, userId)).changes;
  const keep = keepTempRoles.map(String);
  const tempRoles = keep.length
    ? (
        await prepare(
          `DELETE FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? AND role_id NOT IN (${keep.map(() => '?').join(', ')})`
        ).run(guildId, userId, ...keep)
      ).changes
    : (await userStmts.tempRoles.run(guildId, userId)).changes;
  const tempRoleAdders = (await userStmts.tempRoleAdder.run(guildId, userId)).changes;
  const quotes = (await userStmts.quotesAuthored.run(guildId, userId)).changes;
  const quotesSaved = (await userStmts.quotesSaved.run(guildId, userId)).changes;
  // With keepIntroduction the row stays (it holds the ids a later delete needs), without the answers.
  let introductions = 0;
  if (keepIntroduction) await userStmts.introductionsClear.run(Date.now(), guildId, userId);
  else introductions = (await userStmts.introductions.run(guildId, userId)).changes;
  const welcomeSent = (await userStmts.welcomeSent.run(guildId, userId)).changes;
  const keepApps = keepApplicationIds.map(Number).filter(Number.isInteger);
  let applications;
  if (keepApps.length) {
    const marks = keepApps.map(() => '?').join(', ');
    await prepare(
      `UPDATE applications_submissions SET answers = '{}', questions = '[]', cleared = 1, updated_at = ? WHERE guild_id = ? AND user_id = ? AND id IN (${marks})`
    ).run(Date.now(), guildId, userId, ...keepApps);
    applications = (
      await prepare(
        `DELETE FROM applications_submissions WHERE guild_id = ? AND user_id = ? AND id NOT IN (${marks})`
      ).run(guildId, userId, ...keepApps)
    ).changes;
  } else {
    applications = (await userStmts.applications.run(guildId, userId)).changes;
  }
  const applicationsDecided = (await userStmts.applicationsDecider.run(guildId, userId)).changes;
  // Their economy account and ledger rows; where they are named on someone else's row, the name comes off.
  const economy = await eraseMember(guildId, userId);
  const inventory = await eraseInventory(guildId, userId);
  const invites =
    (await userStmts.inviteCounts.run(guildId, userId)).changes +
    (await userStmts.inviteJoins.run(guildId, userId)).changes +
    (await userStmts.inviteJoinsAsInviter.run(guildId, userId)).changes +
    (await userStmts.invitePersonal.run(guildId, userId)).changes;
  const pollsCreated = (await userStmts.pollsCreated.run(guildId, userId)).changes;
  const giveawaysHosted = (await userStmts.giveawaysHosted.run(guildId, userId)).changes;
  const tempVoiceOwned = (await userStmts.tempVoiceOwned.run(guildId, userId)).changes;
  const verificationKicks = (await userStmts.verificationKicks.run(guildId, userId)).changes;
  const ticketsClosed = (await userStmts.ticketsClosed.run(guildId, userId)).changes;
  const appealsDecided = (await userStmts.appealsDecided.run(guildId, userId)).changes;
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
    eventsHosted,
    suggestionVotes,
    suggestions,
    suggestionDecisions,
    tempRoles,
    tempRoleAdders,
    quotes,
    quotesSaved,
    introductions,
    welcomeSent,
    applications,
    applicationsDecided,
    economyAccounts: economy.account,
    economyTransactions: economy.transactions,
    economyNames: economy.counterparty + economy.actor,
    economyInventory: inventory.rows,
    economyFulfilled: inventory.fulfilled,
    invites,
    pollsCreated,
    giveawaysHosted,
    tempVoiceOwned,
    verificationKicks,
    ticketsClosed,
    appealsDecided,
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
    key: 'moderatorCases',
    label: 'Moderation actions they took as staff (kept by /forget)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND moderator_id = ?',
    // What was done and when, not to whom: the members they acted on are other people.
    rowsSql:
      'SELECT case_number, action, created_at FROM infractions WHERE guild_id = ? AND moderator_id = ? ORDER BY case_number',
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
    key: 'giveawayPrizes',
    label: 'Giveaway currency prizes paid to you',
    order: 'ug',
    countSql:
      'SELECT COUNT(*) AS n FROM giveaway_prizes WHERE user_id = ? AND giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)',
    rowsSql:
      'SELECT * FROM giveaway_prizes WHERE user_id = ? AND giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?) ORDER BY paid_at',
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
    key: 'eventsHosted',
    label: 'Events they hosted (/forget keeps the event, drops you as the host)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_events WHERE guild_id = ? AND host_id = ?',
    rowsSql:
      'SELECT id, title, description, location, start_at, end_at, state, created_at FROM guild_events WHERE guild_id = ? AND host_id = ? ORDER BY start_at',
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
    key: 'pollsCreated',
    label: 'Polls they created (/forget keeps the poll, drops you as the creator)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM polls WHERE guild_id = ? AND created_by = ?',
    rowsSql:
      'SELECT message_id, channel_id, question, options, ends_at, created_at FROM polls WHERE guild_id = ? AND created_by = ? ORDER BY created_at',
  },
  {
    key: 'giveawaysHosted',
    label: 'Giveaways they hosted (/forget keeps the giveaway, drops you as the host)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ? AND host_id = ?',
    rowsSql:
      'SELECT id, channel_id, prize, winners, ends_at, ended, created_at FROM giveaways WHERE guild_id = ? AND host_id = ? ORDER BY created_at',
  },
  {
    key: 'tempVoiceOwned',
    label: 'Temporary voice channels they own (/forget leaves the channel without an owner)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?',
    rowsSql:
      'SELECT channel_id, hub_id, name, created_at FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ? ORDER BY created_at',
  },
  {
    key: 'verificationKicks',
    label: 'Pending "kick if not verified" deadline',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM verification_kicks WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM verification_kicks WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'ticketsClosed',
    label: 'Modmail tickets they closed as staff (/forget drops the name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND closed_by = ?',
    rowsSql: 'SELECT id, status, closed_at FROM tickets WHERE guild_id = ? AND closed_by = ? ORDER BY id',
  },
  {
    key: 'appealsDecided',
    label: 'Ban appeals they decided as staff (/forget drops the name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM appeals WHERE guild_id = ? AND decided_by = ?',
    rowsSql:
      'SELECT id, status, decision_reason, decided_at FROM appeals WHERE guild_id = ? AND decided_by = ? ORDER BY id',
  },
  {
    key: 'tempRoles',
    label: 'Temporary roles waiting to be taken back (/forget drops the record, the role stays)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_temp_roles WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM guild_temp_roles WHERE guild_id = ? AND user_id = ? ORDER BY expires_at',
  },
  {
    key: 'tempRoleAdders',
    label: 'Temporary roles they set as staff (/forget drops the name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_temp_roles WHERE guild_id = ? AND added_by = ?',
    rowsSql:
      'SELECT user_id, role_id, expires_at, reason FROM guild_temp_roles WHERE guild_id = ? AND added_by = ? ORDER BY expires_at',
  },
  {
    key: 'quotes',
    label: 'Quotes of their messages on the quote board (/forget deletes them)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_quotes WHERE guild_id = ? AND author_id = ?',
    rowsSql:
      'SELECT number, channel_id, message_id, author_name, body, attachments, message_at, saved_by, saved_at FROM guild_quotes WHERE guild_id = ? AND author_id = ? ORDER BY number',
  },
  {
    key: 'quotesSaved',
    label: 'Quotes they saved from other members (/forget drops their name from them)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM guild_quotes WHERE guild_id = ? AND saved_by = ?',
    rowsSql:
      'SELECT number, channel_id, message_id, saved_at FROM guild_quotes WHERE guild_id = ? AND saved_by = ? ORDER BY number',
  },
  {
    key: 'introductions',
    label: 'Introduction (your answers; /forget also deletes the card)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM introductions WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM introductions WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'welcomeSent',
    label: 'Welcome record (the time Sylo last welcomed you in this server)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM welcome_sent WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT guild_id, user_id, sent_at FROM welcome_sent WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'applications',
    label: 'Applications (your answers; /forget also deletes their posts)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM applications_submissions WHERE guild_id = ? AND user_id = ?',
    rowsSql:
      'SELECT id, form_id, form_name, status, source, questions, answers, reason, decided_at, history, created_at FROM applications_submissions WHERE guild_id = ? AND user_id = ? ORDER BY id',
  },
  {
    key: 'applicationsDecided',
    label: 'Applications you decided as staff (/forget drops your name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM applications_submissions WHERE guild_id = ? AND decided_by = ?',
    rowsSql:
      'SELECT id, form_name, status, decided_at FROM applications_submissions WHERE guild_id = ? AND decided_by = ? ORDER BY id',
  },
  {
    key: 'applicationsCooldowns',
    label:
      'Application cooldown after a denial (kept by /forget until it has run out, so it cannot be skipped)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM applications_cooldowns WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM applications_cooldowns WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'economyAccount',
    label: 'Economy account (cash, bank, daily streak)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'economyTransactions',
    label: 'Economy transactions (the last 180 days)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_transactions WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id',
  },
  {
    key: 'economyCooldowns',
    label: 'Economy cooldown record (kept by /forget for 7 days, so it cannot reset cooldowns)',
    order: 'gu',
    kept: true,
    countSql: 'SELECT COUNT(*) AS n FROM economy_cooldowns WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM economy_cooldowns WHERE guild_id = ? AND user_id = ?',
  },
  {
    key: 'economyInventory',
    label: 'Shop inventory (items you bought or were given)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_inventory WHERE guild_id = ? AND user_id = ?',
    rowsSql: 'SELECT * FROM economy_inventory WHERE guild_id = ? AND user_id = ? ORDER BY id',
  },
  {
    key: 'economyFulfilled',
    label: 'Shop items you marked fulfilled as staff (/forget drops your name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_inventory WHERE guild_id = ? AND fulfilled_by = ?',
    rowsSql:
      'SELECT item_name, fulfilled_at FROM economy_inventory WHERE guild_id = ? AND fulfilled_by = ? ORDER BY id',
  },
  {
    key: 'economyCounterparty',
    label: "Other members' economy transactions that name you (/forget drops your name from them)",
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_transactions WHERE guild_id = ? AND counterparty_id = ?',
    // What and when, not who or how much: the other member's balance is their data.
    rowsSql:
      'SELECT kind, created_at FROM economy_transactions WHERE guild_id = ? AND counterparty_id = ? ORDER BY id',
  },
  {
    key: 'economyActions',
    label: 'Economy changes you made as staff (/forget drops your name)',
    order: 'gu',
    countSql: 'SELECT COUNT(*) AS n FROM economy_transactions WHERE guild_id = ? AND actor_id = ?',
    rowsSql:
      'SELECT kind, created_at FROM economy_transactions WHERE guild_id = ? AND actor_id = ? ORDER BY id',
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
