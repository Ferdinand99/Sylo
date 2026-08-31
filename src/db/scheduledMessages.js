// Reminders (internally still the "scheduled_messages" table). One row per
// reminder; the loop in modules/scheduledMessages.js polls dueReminders() and
// advances next_run_at (recurring) or disables the row (single).
import { db } from './index.js';

const listStmt = db.prepare('SELECT * FROM scheduled_messages WHERE guild_id = ? ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const dueStmt = db.prepare(`
  SELECT * FROM scheduled_messages
  WHERE enabled = 1 AND (
    (mode = 'multiple' AND next_run_at IS NOT NULL AND next_run_at <= @now) OR
    (mode = 'single'   AND run_at      IS NOT NULL AND run_at      <= @now)
  )
  ORDER BY created_at LIMIT 50
`);
const insertStmt = db.prepare(`
  INSERT INTO scheduled_messages
    (guild_id, name, channel_id, content, spec, mode, days, interval_minutes, start_at, end_at, run_at, next_run_at, enabled, created_at)
  VALUES
    (@guildId, @name, @channelId, @content, @spec, @mode, @days, @intervalMinutes, @startAt, @endAt, @runAt, @nextRunAt, 1, @createdAt)
`);
const updateStmt = db.prepare(`
  UPDATE scheduled_messages SET
    name = @name, channel_id = @channelId, content = @content, spec = @spec, mode = @mode, days = @days,
    interval_minutes = @intervalMinutes, start_at = @startAt, end_at = @endAt, run_at = @runAt, next_run_at = @nextRunAt
  WHERE id = @id AND guild_id = @guildId
`);
const deleteStmt = db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const setEnabledStmt = db.prepare('UPDATE scheduled_messages SET enabled = ? WHERE id = ? AND guild_id = ?');
const advanceStmt = db.prepare('UPDATE scheduled_messages SET last_run_at = @now, next_run_at = @nextRunAt WHERE id = @id');
const firedSingleStmt = db.prepare('UPDATE scheduled_messages SET last_run_at = @now, enabled = 0 WHERE id = @id');

const ALL_DAYS = '0,1,2,3,4,5,6';

function hydrate(row) {
  if (!row) return null;
  let spec = null;
  if (row.spec) {
    try {
      spec = JSON.parse(row.spec);
    } catch {
      spec = null;
    }
  }
  if (!spec) spec = { content: row.content ?? '', embeds: [] };
  const days = String(row.days || ALL_DAYS)
    .split(',')
    .map((n) => Number(n))
    .filter((n) => n >= 0 && n <= 6);
  return { ...row, spec, dayList: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
}

export function listScheduled(guildId) {
  return listStmt.all(guildId).map(hydrate);
}
export function getScheduled(guildId, id) {
  return hydrate(getStmt.get(id, guildId));
}
export function dueScheduled(now = Date.now()) {
  return dueStmt.all({ now }).map(hydrate);
}

/**
 * @param {string} guildId
 * @param {object} r  { name, channelId, spec, mode, days:number[], intervalMinutes, startAt, endAt, runAt }
 */
export function createReminder(guildId, r) {
  const now = Date.now();
  // next_run_at is NOT NULL on the table; for single-mode it's unused (the loop
  // keys off run_at) so park it at the run time or the far future.
  const firstRun =
    r.mode === 'single'
      ? r.runAt ?? Number.MAX_SAFE_INTEGER
      : Math.max(now + r.intervalMinutes * 60_000, r.startAt ?? 0);
  return insertStmt.run({
    guildId,
    name: String(r.name ?? '').slice(0, 100),
    channelId: r.channelId,
    content: String(r.spec?.content ?? '').slice(0, 2000),
    spec: JSON.stringify(r.spec ?? { content: '', embeds: [] }),
    mode: r.mode === 'single' ? 'single' : 'multiple',
    days: (Array.isArray(r.days) && r.days.length ? r.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    intervalMinutes: r.intervalMinutes ?? 60,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
    runAt: r.mode === 'single' ? (r.runAt ?? null) : null,
    nextRunAt: firstRun,
    createdAt: now,
  }).lastInsertRowid;
}

export function updateReminder(guildId, id, r) {
  const now = Date.now();
  // next_run_at is NOT NULL on the table; for single-mode it's unused (the loop
  // keys off run_at) so park it at the run time or the far future.
  const firstRun =
    r.mode === 'single'
      ? r.runAt ?? Number.MAX_SAFE_INTEGER
      : Math.max(now + r.intervalMinutes * 60_000, r.startAt ?? 0);
  updateStmt.run({
    guildId,
    id,
    name: String(r.name ?? '').slice(0, 100),
    channelId: r.channelId,
    content: String(r.spec?.content ?? '').slice(0, 2000),
    spec: JSON.stringify(r.spec ?? { content: '', embeds: [] }),
    mode: r.mode === 'single' ? 'single' : 'multiple',
    days: (Array.isArray(r.days) && r.days.length ? r.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    intervalMinutes: r.intervalMinutes ?? 60,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
    runAt: r.mode === 'single' ? (r.runAt ?? null) : null,
    nextRunAt: firstRun,
  });
}

export function deleteScheduled(guildId, id) {
  deleteStmt.run(id, guildId);
}
export function setScheduledEnabled(guildId, id, enabled) {
  setEnabledStmt.run(enabled ? 1 : 0, id, guildId);
}

/** Recurring reminder fired — bump next_run_at by one interval. */
export function advanceReminder(id, intervalMinutes, now = Date.now()) {
  advanceStmt.run({ id, now, nextRunAt: now + intervalMinutes * 60_000 });
}
/** Single reminder fired — mark it done. */
export function markSingleFired(id, now = Date.now()) {
  firedSingleStmt.run({ id, now });
}
