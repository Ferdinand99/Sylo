// Global aggregates for the home dashboard (across every guild the bot serves).
import { db } from './index.js';

const q = {
  warningsTotal: db.prepare('SELECT COUNT(*) AS n FROM warnings'),
  warningsSince: db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE created_at > ?'),
  openTickets: db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'"),
  ticketsTotal: db.prepare('SELECT COUNT(*) AS n FROM tickets'),
  cachedLookups: db.prepare('SELECT COUNT(*) AS n FROM stats_cache'),
  composedTotal: db.prepare('SELECT COUNT(*) AS n FROM composed_messages'),
  moduleUsage: db.prepare(
    'SELECT module_id, COUNT(*) AS n FROM guild_modules WHERE enabled = 1 GROUP BY module_id'
  ),
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Headline counts for the dashboard activity section. */
export function dashboardStats() {
  return {
    warningsTotal: q.warningsTotal.get().n,
    warningsWeek: q.warningsSince.get(Date.now() - WEEK_MS).n,
    openTickets: q.openTickets.get().n,
    ticketsTotal: q.ticketsTotal.get().n,
    cachedLookups: q.cachedLookups.get().n,
    composedTotal: q.composedTotal.get().n,
  };
}

/** Map of module id → number of guilds with it enabled. */
export function moduleUsage() {
  return new Map(q.moduleUsage.all().map((r) => [r.module_id, r.n]));
}
