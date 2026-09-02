// Storage for the Server insights module — an aggregate row per guild per UTC
// day in `guild_daily`, plus a parallel per-UTC-hour row in `guild_hourly` for
// the last-24/48h view. The module accrues counters in memory and calls
// accrueDaily() + accrueHourly() ~hourly; the dashboard reads the series back.
import { db } from './index.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const stmts = {
  getDay: db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?'),
  dayRange: db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day >= ? ORDER BY day ASC'),
  upsertDay: db.prepare(`
    INSERT INTO guild_daily
      (guild_id, day, joins, leaves, messages, active_members,
       voice_minutes, voice_active_members, voice_peak, channels, voice_channels)
    VALUES
      (@guildId, @day, @joins, @leaves, @messages, @active,
       @voiceMinutes, @voiceActive, @voicePeak, @channels, @voiceChannels)
    ON CONFLICT (guild_id, day) DO UPDATE SET
      joins                = joins + excluded.joins,
      leaves               = leaves + excluded.leaves,
      messages             = messages + excluded.messages,
      active_members       = MAX(active_members, excluded.active_members),
      voice_minutes        = voice_minutes + excluded.voice_minutes,
      voice_active_members = MAX(voice_active_members, excluded.voice_active_members),
      voice_peak           = MAX(voice_peak, excluded.voice_peak),
      channels             = excluded.channels,
      voice_channels       = excluded.voice_channels
  `),
  pruneDay: db.prepare('DELETE FROM guild_daily WHERE day < ?'),

  hourRange: db.prepare('SELECT * FROM guild_hourly WHERE guild_id = ? AND hour >= ? ORDER BY hour ASC'),
  upsertHour: db.prepare(`
    INSERT INTO guild_hourly
      (guild_id, hour, joins, leaves, messages, active_members,
       voice_minutes, voice_active_members, voice_peak)
    VALUES
      (@guildId, @hour, @joins, @leaves, @messages, @active,
       @voiceMinutes, @voiceActive, @voicePeak)
    ON CONFLICT (guild_id, hour) DO UPDATE SET
      joins                = joins + excluded.joins,
      leaves               = leaves + excluded.leaves,
      messages             = messages + excluded.messages,
      active_members       = MAX(active_members, excluded.active_members),
      voice_minutes        = voice_minutes + excluded.voice_minutes,
      voice_active_members = MAX(voice_active_members, excluded.voice_active_members),
      voice_peak           = MAX(voice_peak, excluded.voice_peak)
  `),
  pruneHour: db.prepare('DELETE FROM guild_hourly WHERE hour < ?'),
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
export function accrueDaily(guildId, day, d = {}) {
  const existing = stmts.getDay.get(guildId, day);
  stmts.upsertDay.run({
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
export function accrueHourly(guildId, hour, d = {}) {
  stmts.upsertHour.run({
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
    joins: r.joins,
    leaves: r.leaves,
    messages: r.messages,
    activeMembers: r.active_members,
    voiceMinutes: r.voice_minutes,
    voiceActiveMembers: r.voice_active_members,
    voicePeak: r.voice_peak,
  };
}

/**
 * The last `days` daily rows for a guild, oldest first, zero-filled so the
 * charts have a continuous x-axis. Each entry has a `label` ('YYYY-MM-DD').
 */
export function dailySeries(guildId, days = 30) {
  const since = utcDay(Date.now() - (days - 1) * DAY_MS);
  const byKey = new Map(stmts.dayRange.all(guildId, since).map((r) => [r.day, shapeRow(r)]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const label = utcDay(Date.now() - i * DAY_MS);
    out.push({ label, ...zeroRow, ...byKey.get(label) });
  }
  return out;
}

/** Same, per hour, for the last `hours` hours. Each entry's `label` is 'YYYY-MM-DDTHH'. */
export function hourlySeries(guildId, hours = 24) {
  const since = utcHour(Date.now() - (hours - 1) * HOUR_MS);
  const byKey = new Map(stmts.hourRange.all(guildId, since).map((r) => [r.hour, shapeRow(r)]));
  const out = [];
  for (let i = hours - 1; i >= 0; i -= 1) {
    const label = utcHour(Date.now() - i * HOUR_MS);
    out.push({ label, ...zeroRow, ...byKey.get(label) });
  }
  return out;
}

/** Top text channels by message count over the last `days` days. */
export function topChannels(guildId, days = 30, limit = 6) {
  return topFromJson(guildId, days, limit, 'channels');
}

/** Top voice channels by minutes over the last `days` days. */
export function topVoiceChannels(guildId, days = 30, limit = 6) {
  return topFromJson(guildId, days, limit, 'voice_channels').map((e) => ({
    channelId: e.channelId,
    minutes: e.value,
  }));
}

function topFromJson(guildId, days, limit, column) {
  const since = utcDay(Date.now() - (days - 1) * DAY_MS);
  const totals = {};
  for (const r of stmts.dayRange.all(guildId, since)) {
    for (const [ch, n] of Object.entries(safeParse(r[column]))) totals[ch] = (totals[ch] ?? 0) + n;
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([channelId, value]) => ({ channelId, value, messages: value }));
}

/** Drop daily rows older than `days` days and hourly rows older than `hours` hours. */
export function pruneInsights(days = 180, hours = 72) {
  stmts.pruneDay.run(utcDay(Date.now() - days * DAY_MS));
  stmts.pruneHour.run(utcHour(Date.now() - hours * HOUR_MS));
}
