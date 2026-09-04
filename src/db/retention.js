// Enforce the per-guild data-retention limits the Tickets and Moderation
// modules expose:
//   - transcriptRetentionDays (tickets)  — delete closed modmail tickets and
//     their messages once they are older than N days.
//   - infractionRetentionDays (moderation) — delete *inactive* cases (soft
//     deleted with /case delete, or resolved by an unban/untimeout) once they
//     are older than N days. Active cases and the visible history are never
//     touched.
// A guild with the setting at 0 (the default) is left alone. The sweep runs
// once a day, plus once shortly after boot.
import { db } from './index.js';
import { log } from '../lib/log.js';

const DAY_MS = 86_400_000;
const MAX_DAYS = 3650; // 10 years — matches the dashboard input cap

const ticketCfgRows = db.prepare("SELECT guild_id, config FROM guild_modules WHERE module_id = 'tickets'");
const modCfgRows = db.prepare("SELECT guild_id, config FROM guild_modules WHERE module_id = 'moderation'");

const oldClosedTickets = db.prepare(
  "SELECT id FROM tickets WHERE guild_id = ? AND status = 'closed' AND COALESCE(closed_at, last_at) < ?"
);
const delTicketMsgs = db.prepare('DELETE FROM ticket_messages WHERE ticket_id = ?');
const delTicket = db.prepare('DELETE FROM tickets WHERE id = ?');
const delOldInactiveCases = db.prepare(
  'DELETE FROM infractions WHERE guild_id = ? AND active = 0 AND created_at < ?'
);

function retentionDays(configJson, key) {
  let cfg;
  try {
    cfg = JSON.parse(configJson) ?? {};
  } catch {
    return 0;
  }
  const n = Math.floor(Number(cfg[key]));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_DAYS) : 0;
}

const sweep = db.transaction((now) => {
  let closedTickets = 0;
  let ticketMessages = 0;
  let inactiveCases = 0;

  for (const row of ticketCfgRows.all()) {
    const days = retentionDays(row.config, 'transcriptRetentionDays');
    if (!days) continue;
    const cutoff = now - days * DAY_MS;
    for (const { id } of oldClosedTickets.all(row.guild_id, cutoff)) {
      ticketMessages += delTicketMsgs.run(id).changes;
      closedTickets += delTicket.run(id).changes;
    }
  }

  for (const row of modCfgRows.all()) {
    const days = retentionDays(row.config, 'infractionRetentionDays');
    if (!days) continue;
    inactiveCases += delOldInactiveCases.run(row.guild_id, now - days * DAY_MS).changes;
  }

  return { closedTickets, ticketMessages, inactiveCases };
});

/**
 * Delete tickets / cases past their guild's configured retention window.
 * @param {number} [now] epoch ms, overridable for tests
 * @returns {{ closedTickets: number, ticketMessages: number, inactiveCases: number }}
 */
export function sweepRetention(now = Date.now()) {
  const result = sweep(now);
  if (result.closedTickets || result.inactiveCases) {
    log.info(
      'retention',
      `removed ${result.closedTickets} closed ticket(s) / ${result.ticketMessages} message(s) ` +
        `and ${result.inactiveCases} inactive case(s)`
    );
  }
  return result;
}

let started = false;

/** Start the daily retention sweep. Idempotent; call once at boot. */
export function startRetentionSchedule() {
  if (started) return;
  started = true;

  const run = () => {
    try {
      sweepRetention();
    } catch (err) {
      log.error('retention', `sweep failed: ${err.message}`);
    }
  };

  setTimeout(run, 5 * 60_000).unref(); // a first pass a few minutes after boot
  setInterval(run, DAY_MS).unref();
}
