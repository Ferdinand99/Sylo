// Channel cleanup: per-channel weekly schedules that delete messages older
// than a threshold. The tick loop in modules/channelCleanup.js polls
// dueSchedules() every few minutes; last_run_date (a 'YYYY-MM-DD' string, the
// server's local calendar day) stops a schedule firing twice inside one day
// without needing minute-precision timing.
import { db } from './index.js';

const ALL_DAYS = '0,1,2,3,4,5,6';

const listStmt = db.prepare('SELECT * FROM channel_cleanup_schedules WHERE guild_id = ? ORDER BY created_at');
const getStmt = db.prepare('SELECT * FROM channel_cleanup_schedules WHERE id = ? AND guild_id = ?');
// Enabled schedules not yet run today; the module code filters further by
// day-of-week + time-of-day match, which SQLite can't express portably.
const dueCandidatesStmt = db.prepare(
  "SELECT * FROM channel_cleanup_schedules WHERE enabled = 1 AND COALESCE(last_run_date, '') != ?"
);
const insertStmt = db.prepare(`
  INSERT INTO channel_cleanup_schedules
    (guild_id, channel_id, days, time_hhmm, max_age_hours, skip_pinned, enabled, created_at)
  VALUES
    (@guildId, @channelId, @days, @timeHhmm, @maxAgeHours, @skipPinned, 1, @createdAt)
`);
const updateStmt = db.prepare(`
  UPDATE channel_cleanup_schedules SET
    channel_id = @channelId, days = @days, time_hhmm = @timeHhmm,
    max_age_hours = @maxAgeHours, skip_pinned = @skipPinned
  WHERE id = @id AND guild_id = @guildId
`);
const deleteStmt = db.prepare('DELETE FROM channel_cleanup_schedules WHERE id = ? AND guild_id = ?');
const setEnabledStmt = db.prepare(
  'UPDATE channel_cleanup_schedules SET enabled = ? WHERE id = ? AND guild_id = ?'
);
const markRanStmt = db.prepare(
  'UPDATE channel_cleanup_schedules SET last_run_date = @date, last_run_count = @count WHERE id = @id'
);

function hydrate(row) {
  if (!row) return null;
  const days = String(row.days || ALL_DAYS)
    .split(',')
    .map(Number)
    .filter((n) => n >= 0 && n <= 6);
  return { ...row, dayList: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
}

export function listCleanupSchedules(guildId) {
  return listStmt.all(guildId).map(hydrate);
}
export function getCleanupSchedule(guildId, id) {
  return hydrate(getStmt.get(id, guildId));
}
/** Enabled schedules that haven't run on `today` (a 'YYYY-MM-DD' string) yet. */
export function dueCandidates(today) {
  return dueCandidatesStmt.all(today).map(hydrate);
}

/**
 * @param {string} guildId
 * @param {{ channelId: string, days: number[], timeHhmm: string, maxAgeHours: number, skipPinned: boolean }} s
 */
export function createCleanupSchedule(guildId, s) {
  return insertStmt.run({
    guildId,
    channelId: s.channelId,
    days: (Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    timeHhmm: s.timeHhmm,
    maxAgeHours: s.maxAgeHours,
    skipPinned: s.skipPinned ? 1 : 0,
    createdAt: Date.now(),
  }).lastInsertRowid;
}

export function updateCleanupSchedule(guildId, id, s) {
  updateStmt.run({
    guildId,
    id,
    channelId: s.channelId,
    days: (Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    timeHhmm: s.timeHhmm,
    maxAgeHours: s.maxAgeHours,
    skipPinned: s.skipPinned ? 1 : 0,
  });
}

export function deleteCleanupSchedule(guildId, id) {
  deleteStmt.run(id, guildId);
}
export function setCleanupScheduleEnabled(guildId, id, enabled) {
  setEnabledStmt.run(enabled ? 1 : 0, id, guildId);
}
/** A run just happened — record the calendar day so it doesn't fire again today. */
export function markCleanupRan(id, today, count) {
  markRanStmt.run({ id, date: today, count });
}
