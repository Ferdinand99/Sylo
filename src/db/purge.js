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
];

const simpleStmts = GUILD_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE guild_id = ?`));
const ticketMsgStmt = db.prepare(
  'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id = ?)'
);

const purgeGuildTxn = db.transaction((guildId) => {
  ticketMsgStmt.run(guildId); // before `tickets`, which the subquery reads
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
};

const forgetUserTxn = db.transaction((guildId, userId) => {
  const warnings = userStmts.warnings.run(guildId, userId).changes;
  const leveling = userStmts.leveling.run(guildId, userId).changes;
  userStmts.counting.run(guildId, userId);
  const ticketMsgs = userStmts.ticketMsgs.run(guildId, userId).changes;
  const tickets = userStmts.tickets.run(guildId, userId).changes;
  return { warnings, leveling, tickets, ticketMessages: ticketMsgs };
});

/**
 * Erase a single member's data within one guild.
 * @returns {{ warnings: number, leveling: number, tickets: number, ticketMessages: number }}
 */
export function forgetUser(guildId, userId) {
  return forgetUserTxn(guildId, userId);
}
