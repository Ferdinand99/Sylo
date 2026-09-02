// Storage for the Server insights module — one aggregate row per guild per UTC
// day in `guild_daily`. The module accrues counters in memory and calls
// accrueDaily() hourly; the dashboard page reads the series back.
import { db } from './index.js';

const stmts = {
  getDay: db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?'),
  range: db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day >= ? ORDER BY day ASC'),
  upsert: db.prepare(`
    INSERT INTO guild_daily (guild_id, day, joins, leaves, messages, active_members, channels)
    VALUES (@guildId, @day, @joins, @leaves, @messages, @active, @channels)
    ON CONFLICT (guild_id, day) DO UPDATE SET
      joins          = joins + excluded.joins,
      leaves         = leaves + excluded.leaves,
      messages       = messages + excluded.messages,
      active_members = MAX(active_members, excluded.active_members),
      channels       = excluded.channels
  `),
  prune: db.prepare('DELETE FROM guild_daily WHERE day < ?'),
};

/** 'YYYY-MM-DD' for a UTC timestamp (defaults to now). */
export function utcDay(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Fold a batch of counters into a guild's row for `day`. joins/leaves/messages
 * are added; active_members takes the running max; channels replaces the JSON
 * map (the caller merges the day's totals in before calling).
 * @param {string} guildId
 * @param {string} day  'YYYY-MM-DD'
 * @param {{ joins?: number, leaves?: number, messages?: number, activeCount?: number, channels?: Record<string, number> }} d
 */
export function accrueDaily(guildId, day, d = {}) {
  const existing = stmts.getDay.get(guildId, day);
  const merged = existing ? safeParse(existing.channels) : {};
  for (const [ch, n] of Object.entries(d.channels ?? {})) merged[ch] = (merged[ch] ?? 0) + n;

  stmts.upsert.run({
    guildId,
    day,
    joins: d.joins ?? 0,
    leaves: d.leaves ?? 0,
    messages: d.messages ?? 0,
    active: d.activeCount ?? 0,
    channels: JSON.stringify(merged),
  });
}

function safeParse(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * The last `days` days of rows for a guild, oldest first. Missing days are
 * filled with zeroes so the charts have a continuous x-axis.
 */
export function dailySeries(guildId, days = 30) {
  const since = utcDay(Date.now() - (days - 1) * 86_400_000);
  const byDay = new Map(
    stmts.range
      .all(guildId, since)
      .map((r) => [
        r.day,
        { joins: r.joins, leaves: r.leaves, messages: r.messages, activeMembers: r.active_members },
      ])
  );
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = utcDay(Date.now() - i * 86_400_000);
    out.push({ day, joins: 0, leaves: 0, messages: 0, activeMembers: 0, ...byDay.get(day) });
  }
  return out;
}

/** Top channels by message count over the last `days` days. */
export function topChannels(guildId, days = 30, limit = 6) {
  const since = utcDay(Date.now() - (days - 1) * 86_400_000);
  const totals = {};
  for (const r of stmts.range.all(guildId, since)) {
    for (const [ch, n] of Object.entries(safeParse(r.channels))) totals[ch] = (totals[ch] ?? 0) + n;
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([channelId, messages]) => ({ channelId, messages }));
}

/** Drop rows older than `days` days. */
export function pruneInsights(days = 180) {
  stmts.prune.run(utcDay(Date.now() - days * 86_400_000));
}
