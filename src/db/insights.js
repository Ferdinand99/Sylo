// Storage for the Server insights module — an aggregate row per guild per UTC
// day in `guild_daily`, plus a parallel per-UTC-hour row in `guild_hourly` for
// the last-24/48h view. The module accrues counters in memory and calls
// accrueDaily() + accrueHourly() ~hourly; the dashboard reads the series back.
//
// accrueDaily() does a read (getDay) then a write (upsertDay) to merge the
// per-channel JSON maps — not atomic on its own, so it relies on its only
// caller (src/modules/insights.js's flushSlot()) never running twice
// concurrently for the same guild, which that file guards explicitly. See
// its comment for why that guard is needed once this file's calls are async.
import { prepare, registerPostgresBootstrap } from './driver.js';

// Schema copied verbatim from these tables' cumulative SQLite migrations in
// index.js. purge.js used to bootstrap both tables itself (guild_daily and
// guild_hourly were GUILD_TABLES entries with no owning file yet); that block
// moved here now that this file is converted — see docs/roadmap.md, Phase 22.
registerPostgresBootstrap(`
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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const stmts = {
  getDay: prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?'),
  dayRange: prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day >= ? ORDER BY day ASC'),
  upsertDay: prepare(`
    INSERT INTO guild_daily
      (guild_id, day, joins, leaves, messages, active_members,
       voice_minutes, voice_active_members, voice_peak, channels, voice_channels)
    VALUES
      (@guildId, @day, @joins, @leaves, @messages, @active,
       @voiceMinutes, @voiceActive, @voicePeak, @channels, @voiceChannels)
    ON CONFLICT (guild_id, day) DO UPDATE SET
      joins                = guild_daily.joins + excluded.joins,
      leaves               = guild_daily.leaves + excluded.leaves,
      messages             = guild_daily.messages + excluded.messages,
      active_members       = CASE WHEN guild_daily.active_members > excluded.active_members
                                   THEN guild_daily.active_members ELSE excluded.active_members END,
      voice_minutes        = guild_daily.voice_minutes + excluded.voice_minutes,
      voice_active_members = CASE WHEN guild_daily.voice_active_members > excluded.voice_active_members
                                   THEN guild_daily.voice_active_members ELSE excluded.voice_active_members END,
      voice_peak           = CASE WHEN guild_daily.voice_peak > excluded.voice_peak
                                   THEN guild_daily.voice_peak ELSE excluded.voice_peak END,
      channels             = excluded.channels,
      voice_channels       = excluded.voice_channels
  `),
  pruneDay: prepare('DELETE FROM guild_daily WHERE day < ?'),

  hourRange: prepare('SELECT * FROM guild_hourly WHERE guild_id = ? AND hour >= ? ORDER BY hour ASC'),
  upsertHour: prepare(`
    INSERT INTO guild_hourly
      (guild_id, hour, joins, leaves, messages, active_members,
       voice_minutes, voice_active_members, voice_peak)
    VALUES
      (@guildId, @hour, @joins, @leaves, @messages, @active,
       @voiceMinutes, @voiceActive, @voicePeak)
    ON CONFLICT (guild_id, hour) DO UPDATE SET
      joins                = guild_hourly.joins + excluded.joins,
      leaves               = guild_hourly.leaves + excluded.leaves,
      messages             = guild_hourly.messages + excluded.messages,
      active_members       = CASE WHEN guild_hourly.active_members > excluded.active_members
                                   THEN guild_hourly.active_members ELSE excluded.active_members END,
      voice_minutes        = guild_hourly.voice_minutes + excluded.voice_minutes,
      voice_active_members = CASE WHEN guild_hourly.voice_active_members > excluded.voice_active_members
                                   THEN guild_hourly.voice_active_members ELSE excluded.voice_active_members END,
      voice_peak           = CASE WHEN guild_hourly.voice_peak > excluded.voice_peak
                                   THEN guild_hourly.voice_peak ELSE excluded.voice_peak END
  `),
  pruneHour: prepare('DELETE FROM guild_hourly WHERE hour < ?'),
};

/** 'YYYY-MM-DD' for a UTC timestamp (defaults to now). */
export function utcDay(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DDTHH' for a UTC timestamp (defaults to now). */
export function utcHour(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 13);
}

function safeParse(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function mergeMap(existingJson, delta) {
  const merged = safeParse(existingJson);
  for (const [k, v] of Object.entries(delta ?? {})) merged[k] = (merged[k] ?? 0) + v;
  return JSON.stringify(merged);
}

/**
 * Fold a batch of counters into a guild's `guild_daily` row for `day`.
 * joins/leaves/messages/voice_minutes are added; the *_members / *_peak columns
 * take a running MAX; the JSON maps are merged (client passes deltas).
 * @param {string} guildId
 * @param {string} day  'YYYY-MM-DD'
 * @param {object} d
 */
export async function accrueDaily(guildId, day, d = {}) {
  const existing = await stmts.getDay.get(guildId, day);
  await stmts.upsertDay.run({
    guildId,
    day,
    joins: d.joins ?? 0,
    leaves: d.leaves ?? 0,
    messages: d.messages ?? 0,
    active: d.activeCount ?? 0,
    voiceMinutes: d.voiceMinutes ?? 0,
    voiceActive: d.voiceActiveCount ?? 0,
    voicePeak: d.voicePeak ?? 0,
    channels: mergeMap(existing?.channels, d.channels),
    voiceChannels: mergeMap(existing?.voice_channels, d.voiceChannels),
  });
}

/** Same, for the `guild_hourly` row. No per-channel JSON on the hourly table. */
export async function accrueHourly(guildId, hour, d = {}) {
  await stmts.upsertHour.run({
    guildId,
    hour,
    joins: d.joins ?? 0,
    leaves: d.leaves ?? 0,
    messages: d.messages ?? 0,
    active: d.activeCount ?? 0,
    voiceMinutes: d.voiceMinutes ?? 0,
    voiceActive: d.voiceActiveCount ?? 0,
    voicePeak: d.voicePeak ?? 0,
  });
}

const zeroRow = {
  joins: 0,
  leaves: 0,
  messages: 0,
  activeMembers: 0,
  voiceMinutes: 0,
  voiceActiveMembers: 0,
  voicePeak: 0,
};

function shapeRow(r) {
  return {
    joins: Number(r.joins) || 0,
    leaves: Number(r.leaves) || 0,
    messages: Number(r.messages) || 0,
    activeMembers: Number(r.active_members) || 0,
    voiceMinutes: Number(r.voice_minutes) || 0,
    voiceActiveMembers: Number(r.voice_active_members) || 0,
    voicePeak: Number(r.voice_peak) || 0,
  };
}

/**
 * The last `days` daily rows for a guild, oldest first, zero-filled so the
 * charts have a continuous x-axis. Each entry has a `label` ('YYYY-MM-DD').
 */
export async function dailySeries(guildId, days = 30) {
  const since = utcDay(Date.now() - (days - 1) * DAY_MS);
  const byKey = new Map((await stmts.dayRange.all(guildId, since)).map((r) => [r.day, shapeRow(r)]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const label = utcDay(Date.now() - i * DAY_MS);
    out.push({ label, ...zeroRow, ...byKey.get(label) });
  }
  return out;
}

/** Same, per hour, for the last `hours` hours. Each entry's `label` is 'YYYY-MM-DDTHH'. */
export async function hourlySeries(guildId, hours = 24) {
  const since = utcHour(Date.now() - (hours - 1) * HOUR_MS);
  const byKey = new Map((await stmts.hourRange.all(guildId, since)).map((r) => [r.hour, shapeRow(r)]));
  const out = [];
  for (let i = hours - 1; i >= 0; i -= 1) {
    const label = utcHour(Date.now() - i * HOUR_MS);
    out.push({ label, ...zeroRow, ...byKey.get(label) });
  }
  return out;
}

/** Top text channels by message count over the last `days` days. */
export async function topChannels(guildId, days = 30, limit = 6) {
  return topFromJson(guildId, days, limit, 'channels');
}

/** Top voice channels by minutes over the last `days` days. */
export async function topVoiceChannels(guildId, days = 30, limit = 6) {
  return (await topFromJson(guildId, days, limit, 'voice_channels')).map((e) => ({
    channelId: e.channelId,
    minutes: e.value,
  }));
}

async function topFromJson(guildId, days, limit, column) {
  const since = utcDay(Date.now() - (days - 1) * DAY_MS);
  const totals = {};
  for (const r of await stmts.dayRange.all(guildId, since)) {
    for (const [ch, n] of Object.entries(safeParse(r[column]))) totals[ch] = (totals[ch] ?? 0) + n;
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([channelId, value]) => ({ channelId, value, messages: value }));
}

/** Drop daily rows older than `days` days and hourly rows older than `hours` hours. */
export async function pruneInsights(days = 180, hours = 72) {
  await stmts.pruneDay.run(utcDay(Date.now() - days * DAY_MS));
  await stmts.pruneHour.run(utcHour(Date.now() - hours * HOUR_MS));
}
