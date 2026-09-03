// Moderation case log: one numbered row per moderation action, per guild.
// Migration 35 folded the old flat `warnings` table in here as `action='warn'`
// rows. Consumed by /warn, /history, /case, the auto-threshold flow, automod's
// warn action, the temp-ban expiry loop, and the moderation dashboard.
//
// `active` is 1 for a case still "in effect"; /case delete soft-deletes it to 0
// (kept for audit, dropped from /history and the warn count), and /unban /
// /untimeout flip the matching ban/timeout case to 0.
import { db } from './index.js';

export const CASE_ACTIONS = ['warn', 'note', 'timeout', 'untimeout', 'kick', 'ban', 'unban'];

const nextNumStmt = db.prepare(
  'SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM infractions WHERE guild_id = ?'
);
const insertStmt = db.prepare(`
  INSERT INTO infractions
    (guild_id, case_number, user_id, moderator_id, action, reason, detail, active, created_at)
  VALUES (@guildId, @caseNumber, @userId, @moderatorId, @action, @reason, @detail, 1, @createdAt)
`);
const warnCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND active = 1"
);
const getStmt = db.prepare('SELECT * FROM infractions WHERE guild_id = ? AND case_number = ?');
const userListStmt = db.prepare(`
  SELECT * FROM infractions
  WHERE guild_id = @guildId AND user_id = @userId AND (active = 1 OR @includeInactive = 1)
  ORDER BY case_number DESC
  LIMIT @limit OFFSET @offset
`);
const userCountStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM infractions
  WHERE guild_id = @guildId AND user_id = @userId AND (active = 1 OR @includeInactive = 1)
`);
const guildListStmt = db.prepare(
  'SELECT * FROM infractions WHERE guild_id = ? ORDER BY case_number DESC LIMIT ?'
);
const guildCountStmt = db.prepare('SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ?');
const editReasonStmt = db.prepare('UPDATE infractions SET reason = ? WHERE guild_id = ? AND case_number = ?');
const setActiveStmt = db.prepare('UPDATE infractions SET active = ? WHERE guild_id = ? AND case_number = ?');
const latestActiveStmt = db.prepare(`
  SELECT case_number FROM infractions
  WHERE guild_id = ? AND user_id = ? AND action = ? AND active = 1
  ORDER BY case_number DESC LIMIT 1
`);
const deleteWarnStmt = db.prepare(
  "DELETE FROM infractions WHERE guild_id = ? AND case_number = ? AND action = 'warn'"
);
const clearWarnStmt = db.prepare(
  "DELETE FROM infractions WHERE guild_id = ? AND user_id = ? AND action = 'warn'"
);
const listWarnStmt = db.prepare(`
  SELECT case_number AS id, moderator_id, reason, created_at
  FROM infractions
  WHERE guild_id = ? AND user_id = ? AND action = 'warn'
  ORDER BY created_at DESC
`);

// --- case log API ------------------------------------------------------

/**
 * Record a moderation case. In a transaction so the per-guild case number can't
 * collide under concurrent writes.
 * @param {{ guildId: string, userId: string, moderatorId: string, action: string,
 *           reason?: string, detail?: string|null }} c
 * @returns {{ caseNumber: number, warnCount: number }}
 */
export const addCase = db.transaction((c) => {
  const caseNumber = nextNumStmt.get(c.guildId).n;
  insertStmt.run({
    guildId: c.guildId,
    caseNumber,
    userId: c.userId,
    moderatorId: String(c.moderatorId ?? ''),
    action: CASE_ACTIONS.includes(c.action) ? c.action : 'note',
    reason: String(c.reason ?? '').slice(0, 1000),
    detail: c.detail == null ? null : String(c.detail).slice(0, 200),
    createdAt: Date.now(),
  });
  return { caseNumber, warnCount: warnCountStmt.get(c.guildId, c.userId).n };
});

/** One case by its per-guild number, or null. */
export function getCase(guildId, caseNumber) {
  return getStmt.get(guildId, caseNumber) ?? null;
}

/**
 * A member's cases, newest first.
 * @returns {{ rows: object[], total: number }}
 */
export function listUserCases(guildId, userId, { limit = 10, offset = 0, includeInactive = false } = {}) {
  const inc = includeInactive ? 1 : 0;
  return {
    rows: userListStmt.all({ guildId, userId, includeInactive: inc, limit, offset }),
    total: userCountStmt.get({ guildId, userId, includeInactive: inc }).n,
  };
}

/** Every case in a guild, newest first, plus the total. */
export function listGuildCases(guildId, limit = 200) {
  return { rows: guildListStmt.all(guildId, limit), total: guildCountStmt.get(guildId).n };
}

/** @returns {boolean} whether a row changed */
export function editCaseReason(guildId, caseNumber, reason) {
  return editReasonStmt.run(String(reason ?? '').slice(0, 1000), guildId, caseNumber).changes > 0;
}

/** @returns {boolean} whether a row changed */
export function setCaseActive(guildId, caseNumber, active) {
  return setActiveStmt.run(active ? 1 : 0, guildId, caseNumber).changes > 0;
}

/**
 * Flip the member's most recent still-active case of `action` to inactive
 * (used by /unban and /untimeout). Returns its number, or null if none.
 */
export function deactivateLatest(guildId, userId, action) {
  const row = latestActiveStmt.get(guildId, userId, action);
  if (!row) return null;
  setActiveStmt.run(0, guildId, row.case_number);
  return row.case_number;
}

// --- warning-flavoured compatibility wrappers -------------------------
// The /warn command group and the dashboard's warning forms speak in terms of
// "warnings"; these keep them working on top of the case log.

/** @returns {{ id: number, count: number }} case number + the member's active-warn count */
export function addWarning({ guildId, userId, moderatorId, reason }) {
  const r = addCase({ guildId, userId, moderatorId, action: 'warn', reason });
  return { id: r.caseNumber, count: r.warnCount };
}

/** A warn case by number, or null if that case isn't a warning. */
export function getWarning(guildId, id) {
  const c = getCase(guildId, id);
  return c && c.action === 'warn' ? c : null;
}

/** Hard-delete a warn case (matches the historic /warn remove). */
export function removeWarning(guildId, id) {
  return deleteWarnStmt.run(guildId, id).changes > 0;
}

/** Hard-delete every warn case for a member. @returns {number} rows removed */
export function clearWarnings(guildId, userId) {
  return clearWarnStmt.run(guildId, userId).changes;
}

export function listWarnings(guildId, userId) {
  return listWarnStmt.all(guildId, userId);
}
