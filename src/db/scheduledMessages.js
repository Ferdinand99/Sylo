// Scheduled (recurring) messages. One row per job; the scheduler loop in
// modules/scheduledMessages.js polls dueScheduled() and advances next_run_at.
import { db } from './index.js';

const listStmt = db.prepare('SELECT * FROM scheduled_messages WHERE guild_id = ? ORDER BY created_at');
const getStmt = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const dueStmt = db.prepare(
  'SELECT * FROM scheduled_messages WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 50'
);
const insertStmt = db.prepare(`
  INSERT INTO scheduled_messages (guild_id, channel_id, content, interval_minutes, next_run_at, enabled, created_at)
  VALUES (@guildId, @channelId, @content, @intervalMinutes, @nextRunAt, 1, @createdAt)
`);
const deleteStmt = db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const setEnabledStmt = db.prepare('UPDATE scheduled_messages SET enabled = ? WHERE id = ? AND guild_id = ?');
const markRanStmt = db.prepare(
  'UPDATE scheduled_messages SET last_run_at = @now, next_run_at = @nextRunAt WHERE id = @id'
);

export function listScheduled(guildId) {
  return listStmt.all(guildId);
}

export function getScheduled(guildId, id) {
  return getStmt.get(id, guildId);
}

/** Enabled jobs whose next run time has passed (across every guild). */
export function dueScheduled(now = Date.now()) {
  return dueStmt.all(now);
}

/**
 * @param {string} guildId
 * @param {{ channelId: string, content: string, intervalMinutes: number }} job
 */
export function createScheduled(guildId, { channelId, content, intervalMinutes }) {
  const now = Date.now();
  return insertStmt.run({
    guildId,
    channelId,
    content: String(content).slice(0, 2000),
    intervalMinutes,
    nextRunAt: now + intervalMinutes * 60_000,
    createdAt: now,
  }).lastInsertRowid;
}

export function deleteScheduled(guildId, id) {
  deleteStmt.run(id, guildId);
}

export function setScheduledEnabled(guildId, id, enabled) {
  setEnabledStmt.run(enabled ? 1 : 0, id, guildId);
}

/** Advance a job after it has fired. */
export function markScheduledRan(id, intervalMinutes, now = Date.now()) {
  markRanStmt.run({ id, now, nextRunAt: now + intervalMinutes * 60_000 });
}
