// Moderation case log: one numbered row per moderation action, per guild.
// Migration 35 folded the old flat `warnings` table in here as `action='warn'`
// rows. Consumed by /warn, /history, /case, the auto-threshold flow, automod's
// warn action, the temp-ban expiry loop, and the moderation dashboard.
//
// `active` is 1 for a case still "in effect"; /case delete soft-deletes it to 0
// (kept for audit, dropped from /history and the warn count), and /unban /
// /untimeout flip the matching ban/timeout case to 0.
import { prepare, registerPostgresBootstrap } from './driver.js';

export const CASE_ACTIONS = ['warn', 'note', 'timeout', 'untimeout', 'kick', 'ban', 'unban'];

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS infractions (
    guild_id     TEXT NOT NULL,
    case_number  INTEGER NOT NULL,
    user_id      TEXT NOT NULL,
    moderator_id TEXT NOT NULL DEFAULT '',
    action       TEXT NOT NULL,
    reason       TEXT NOT NULL DEFAULT '',
    detail       TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (guild_id, case_number)
  );
  CREATE INDEX IF NOT EXISTS idx_infractions_user ON infractions (guild_id, user_id, case_number DESC);

  CREATE TABLE IF NOT EXISTS case_counters (
    guild_id    TEXT PRIMARY KEY,
    next_number INTEGER NOT NULL DEFAULT 0
  );
`);

// Claims the next per-guild case number atomically — a single
// upsert-with-increment (same proven pattern as inviteTracker.js's
// bumpRegular), race-free under concurrent writers without a transaction.
// Replaces the old `SELECT MAX(case_number)+1` wrapped in a
// `db.transaction()`: better-sqlite3's transaction() requires a fully
// synchronous callback (any `await` inside breaks its atomicity guarantee,
// since the wrapper can't tell the difference between "done" and "suspended
// at the first await"), which the async `prepare()` shim can't offer, and a
// hand-rolled async-transaction-with-queue can't stop an unrelated,
// non-transactional statement from a different request interleaving on
// SQLite's single shared connection. An atomic single-statement claim
// sidesteps the problem entirely instead of needing to solve it.
const claimCaseNumberStmt = prepare(`
  INSERT INTO case_counters (guild_id, next_number) VALUES (@guildId, 1)
  ON CONFLICT (guild_id) DO UPDATE SET next_number = case_counters.next_number + 1
  RETURNING next_number
`);
const insertStmt = prepare(`
  INSERT INTO infractions
    (guild_id, case_number, user_id, moderator_id, action, reason, detail, active, created_at)
  VALUES (@guildId, @caseNumber, @userId, @moderatorId, @action, @reason, @detail, 1, @createdAt)
`);
const warnCountStmt = prepare(
  "SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND active = 1"
);
const getStmt = prepare('SELECT * FROM infractions WHERE guild_id = ? AND case_number = ?');
const userListStmt = prepare(`
  SELECT * FROM infractions
  WHERE guild_id = @guildId AND user_id = @userId AND (active = 1 OR @includeInactive = 1)
  ORDER BY case_number DESC
  LIMIT @limit OFFSET @offset
`);
const userCountStmt = prepare(`
  SELECT COUNT(*) AS n FROM infractions
  WHERE guild_id = @guildId AND user_id = @userId AND (active = 1 OR @includeInactive = 1)
`);
const guildListStmt = prepare(
  'SELECT * FROM infractions WHERE guild_id = ? ORDER BY case_number DESC LIMIT ?'
);
const guildCountStmt = prepare('SELECT COUNT(*) AS n FROM infractions WHERE guild_id = ?');
const editReasonStmt = prepare('UPDATE infractions SET reason = ? WHERE guild_id = ? AND case_number = ?');
const setActiveStmt = prepare('UPDATE infractions SET active = ? WHERE guild_id = ? AND case_number = ?');
const latestActiveStmt = prepare(`
  SELECT case_number FROM infractions
  WHERE guild_id = ? AND user_id = ? AND action = ? AND active = 1
  ORDER BY case_number DESC LIMIT 1
`);
const deleteWarnStmt = prepare(
  "DELETE FROM infractions WHERE guild_id = ? AND case_number = ? AND action = 'warn'"
);
const clearWarnStmt = prepare(
  "DELETE FROM infractions WHERE guild_id = ? AND user_id = ? AND action = 'warn'"
);
const listWarnStmt = prepare(`
  SELECT case_number AS id, moderator_id, reason, created_at
  FROM infractions
  WHERE guild_id = ? AND user_id = ? AND action = 'warn'
  ORDER BY created_at DESC
`);

// --- case log API ------------------------------------------------------

/**
 * Record a moderation case. The per-guild case number is claimed atomically
 * (see claimCaseNumberStmt above), so it can't collide under concurrent
 * writes even without a transaction.
 * @param {{ guildId: string, userId: string, moderatorId: string, action: string,
 *           reason?: string, detail?: string|null }} c
 * @returns {Promise<{ caseNumber: number, warnCount: number }>}
 */
export async function addCase(c) {
  const claim = await claimCaseNumberStmt.get({ guildId: c.guildId });
  const caseNumber = Number(claim.next_number);
  await insertStmt.run({
    guildId: c.guildId,
    caseNumber,
    userId: c.userId,
    moderatorId: String(c.moderatorId ?? ''),
    action: CASE_ACTIONS.includes(c.action) ? c.action : 'note',
    reason: String(c.reason ?? '').slice(0, 1000),
    detail: c.detail == null ? null : String(c.detail).slice(0, 200),
    createdAt: Date.now(),
  });
  const warnCount = Number((await warnCountStmt.get(c.guildId, c.userId))?.n) || 0;
  return { caseNumber, warnCount };
}

/** One case by its per-guild number, or null. */
export async function getCase(guildId, caseNumber) {
  return (await getStmt.get(guildId, caseNumber)) ?? null;
}

/**
 * A member's cases, newest first.
 * @returns {Promise<{ rows: object[], total: number }>}
 */
export async function listUserCases(
  guildId,
  userId,
  { limit = 10, offset = 0, includeInactive = false } = {}
) {
  const inc = includeInactive ? 1 : 0;
  const rows = await userListStmt.all({ guildId, userId, includeInactive: inc, limit, offset });
  const total = Number((await userCountStmt.get({ guildId, userId, includeInactive: inc }))?.n) || 0;
  return { rows, total };
}

/** Every case in a guild, newest first, plus the total. */
export async function listGuildCases(guildId, limit = 200) {
  const rows = await guildListStmt.all(guildId, limit);
  const total = Number((await guildCountStmt.get(guildId))?.n) || 0;
  return { rows, total };
}

/** @returns {Promise<boolean>} whether a row changed */
export async function editCaseReason(guildId, caseNumber, reason) {
  const info = await editReasonStmt.run(String(reason ?? '').slice(0, 1000), guildId, caseNumber);
  return info.changes > 0;
}

/** @returns {Promise<boolean>} whether a row changed */
export async function setCaseActive(guildId, caseNumber, active) {
  const info = await setActiveStmt.run(active ? 1 : 0, guildId, caseNumber);
  return info.changes > 0;
}

/**
 * Flip the member's most recent still-active case of `action` to inactive
 * (used by /unban and /untimeout). Returns its number, or null if none.
 */
export async function deactivateLatest(guildId, userId, action) {
  const row = await latestActiveStmt.get(guildId, userId, action);
  if (!row) return null;
  await setActiveStmt.run(0, guildId, row.case_number);
  return row.case_number;
}

// --- warning-flavoured compatibility wrappers -------------------------
// The /warn command group and the dashboard's warning forms speak in terms of
// "warnings"; these keep them working on top of the case log.

/** @returns {Promise<{ id: number, count: number }>} case number + the member's active-warn count */
export async function addWarning({ guildId, userId, moderatorId, reason }) {
  const r = await addCase({ guildId, userId, moderatorId, action: 'warn', reason });
  return { id: r.caseNumber, count: r.warnCount };
}

/** A warn case by number, or null if that case isn't a warning. */
export async function getWarning(guildId, id) {
  const c = await getCase(guildId, id);
  return c && c.action === 'warn' ? c : null;
}

/** Hard-delete a warn case (matches the historic /warn remove). */
export async function removeWarning(guildId, id) {
  const info = await deleteWarnStmt.run(guildId, id);
  return info.changes > 0;
}

/** Hard-delete every warn case for a member. @returns {Promise<number>} rows removed */
export async function clearWarnings(guildId, userId) {
  const info = await clearWarnStmt.run(guildId, userId);
  return info.changes;
}

export async function listWarnings(guildId, userId) {
  return listWarnStmt.all(guildId, userId);
}
