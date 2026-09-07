// Global aggregates for the home dashboard (across every guild the bot serves).
// No registerPostgresBootstrap here — no table of its own, only reads tables
// bootstrapped by their owning files (infractions, tickets, stats_cache,
// composed_messages, guild_modules).
import { prepare } from './driver.js';

const q = {
  warningsTotal: prepare("SELECT COUNT(*) AS n FROM infractions WHERE action = 'warn'"),
  warningsSince: prepare("SELECT COUNT(*) AS n FROM infractions WHERE action = 'warn' AND created_at > ?"),
  openTickets: prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'"),
  ticketsTotal: prepare('SELECT COUNT(*) AS n FROM tickets'),
  cachedLookups: prepare('SELECT COUNT(*) AS n FROM stats_cache'),
  composedTotal: prepare('SELECT COUNT(*) AS n FROM composed_messages'),
  moduleUsage: prepare(
    'SELECT module_id, COUNT(*) AS n FROM guild_modules WHERE enabled = 1 GROUP BY module_id'
  ),
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Headline counts for the dashboard activity section. */
export async function dashboardStats() {
  return {
    warningsTotal: Number((await q.warningsTotal.get())?.n) || 0,
    warningsWeek: Number((await q.warningsSince.get(Date.now() - WEEK_MS))?.n) || 0,
    openTickets: Number((await q.openTickets.get())?.n) || 0,
    ticketsTotal: Number((await q.ticketsTotal.get())?.n) || 0,
    cachedLookups: Number((await q.cachedLookups.get())?.n) || 0,
    composedTotal: Number((await q.composedTotal.get())?.n) || 0,
  };
}

/** Map of module id → number of guilds with it enabled. */
export async function moduleUsage() {
  return new Map((await q.moduleUsage.all()).map((r) => [r.module_id, Number(r.n) || 0]));
}
