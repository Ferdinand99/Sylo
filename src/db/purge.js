// Delete every stored row for a guild. Used when Sylo is removed from a server
// and by the /forget data-deletion command.
import { db } from './index.js';

// Tables keyed directly by guild_id.
const GUILD_TABLES = [
  'guild_settings',
  'guild_modules',
  'command_overrides',
  'warnings',
  'tickets',
  'composed_messages',
  'counting',
  'scheduled_messages',
  'leveling',
  'config_audit',
  'afk',
  'free_games_posted',
  'appeals',
  'temp_voice_channels',
  'starboard_posts',
  'invite_counts',
  'invite_joins',
  'invite_personal',
  'polls',
  'twitch_live',
  'youtube_video_seen',
  'youtube_live',
  'giveaways',
  'leaderboard_vanity',
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
  warnings: db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?'),
  leveling: db.prepare('DELETE FROM leveling WHERE guild_id = ? AND user_id = ?'),
  counting: db.prepare(
    "UPDATE counting SET last_user_id = NULL WHERE guild_id = ? AND last_user_id = ?"
  ),
  ticketMsgs: db.prepare(`
    DELETE FROM ticket_messages
    WHERE author_kind = 'user'
      AND ticket_id IN (SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?)
  `),
  tickets: db.prepare('DELETE FROM tickets WHERE guild_id = ? AND user_id = ?'),
  appeals: db.prepare('DELETE FROM appeals WHERE guild_id = ? AND user_id = ?'),
  afk: db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?'),
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
  const leveling = userStmts.leveling.run(guildId, userId).changes;
  userStmts.counting.run(guildId, userId);
  const ticketMsgs = userStmts.ticketMsgs.run(guildId, userId).changes;
  const tickets = userStmts.tickets.run(guildId, userId).changes;
  const appeals = userStmts.appeals.run(guildId, userId).changes;
  const afk = userStmts.afk.run(guildId, userId).changes;
  const giveawayEntries = userStmts.giveawayEntries.run(guildId, userId).changes;
  const invites =
    userStmts.inviteCounts.run(guildId, userId).changes +
    userStmts.inviteJoins.run(guildId, userId).changes +
    userStmts.inviteJoinsAsInviter.run(guildId, userId).changes +
    userStmts.invitePersonal.run(guildId, userId).changes;
  return { warnings, leveling, tickets, ticketMessages: ticketMsgs, appeals, afk, giveawayEntries, invites };
});

/**
 * Erase a single member's data within one guild. Covers the tables that key on
 * a Discord user id; a completed giveaway's host/winner list and the config
 * audit log (which records a display name, not an id) are guild records and are
 * only removed by {@link purgeGuild}.
 * @returns {{ warnings: number, leveling: number, tickets: number, ticketMessages: number, appeals: number, afk: number, giveawayEntries: number, invites: number }}
 */
export function forgetUser(guildId, userId) {
  return forgetUserTxn(guildId, userId);
}
