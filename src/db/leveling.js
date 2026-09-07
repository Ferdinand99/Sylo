// Per-member XP / level state for the leveling module.
//
// Two rollups are kept in step by addXp():
//   - `leveling`          — all-time totals (xp, level, messages, voice_xp)
//   - `leveling_periods`  — one row per (member, period) where period is
//                           `w:<ISO-year>-W<ww>` or `m:<year>-<mm>`, powering the
//                           weekly / monthly leaderboards.
import { prepare, registerPostgresBootstrap } from './driver.js';
import { levelFromXp } from '../modules/lib/levels.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS leveling (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    xp            INTEGER NOT NULL DEFAULT 0,
    level         INTEGER NOT NULL DEFAULT 0,
    messages      INTEGER NOT NULL DEFAULT 0,
    last_msg_at   BIGINT NOT NULL DEFAULT 0,
    voice_xp      INTEGER NOT NULL DEFAULT 0,
    voice_minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_leveling_rank ON leveling (guild_id, xp DESC);

  CREATE TABLE IF NOT EXISTS leveling_periods (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    period   TEXT NOT NULL,
    xp       INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    voice_xp INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, period)
  );
  CREATE INDEX IF NOT EXISTS idx_leveling_periods ON leveling_periods (guild_id, period, xp DESC);
`);

const getStmt = prepare('SELECT * FROM leveling WHERE guild_id = ? AND user_id = ?');

// Atomic upsert-with-increment (same proven pattern as inviteTracker.js's
// bumpRegular) instead of the old db.transaction()-wrapped
// "read prev, compute in JS, write" — see the comment on addXp below for why.
// `level` is intentionally NOT set here: it depends on levelFromXp(), a JS
// curve lookup with no practical single-expression SQL equivalent, so it's
// computed from the RETURNed post-increment xp and written by a second,
// self-correcting statement (setLevelIfHigherStmt).
const bumpStmt = prepare(`
  INSERT INTO leveling (guild_id, user_id, xp, level, messages, voice_xp, voice_minutes, last_msg_at)
  VALUES (@guildId, @userId, @add, 0, @msgInc, @voiceInc, @minsInc, @lastMsgAt)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = leveling.xp + @add,
    messages = leveling.messages + @msgInc,
    voice_xp = leveling.voice_xp + @voiceInc,
    voice_minutes = leveling.voice_minutes + @minsInc,
    last_msg_at = CASE WHEN @voice = 1 THEN leveling.last_msg_at ELSE @lastMsgAt END
  RETURNING xp, messages, voice_xp, voice_minutes, last_msg_at
`);
// Guarded so an out-of-order write (a slower request's lower level landing
// after a faster concurrent one's higher level) can never regress a member's
// stored level — level only ever moves up, matching addXp() only ever adding
// (never subtracting) XP.
const setLevelIfHigherStmt = prepare(
  'UPDATE leveling SET level = @level WHERE guild_id = @guildId AND user_id = @userId AND level < @level'
);
const upsertStmt = prepare(`
  INSERT INTO leveling (guild_id, user_id, xp, level, messages, voice_xp, voice_minutes, last_msg_at)
  VALUES (@guildId, @userId, @xp, @level, @messages, @voiceXp, @voiceMinutes, @lastMsgAt)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = excluded.xp, level = excluded.level,
    messages = excluded.messages, voice_xp = excluded.voice_xp,
    voice_minutes = excluded.voice_minutes,
    last_msg_at = excluded.last_msg_at
`);
const periodUpsertStmt = prepare(`
  INSERT INTO leveling_periods (guild_id, user_id, period, xp, messages, voice_xp)
  VALUES (@guildId, @userId, @period, @xp, @messages, @voiceXp)
  ON CONFLICT (guild_id, user_id, period) DO UPDATE SET
    xp = leveling_periods.xp + excluded.xp,
    messages = leveling_periods.messages + excluded.messages,
    voice_xp = leveling_periods.voice_xp + excluded.voice_xp
`);
const topStmt = prepare('SELECT * FROM leveling WHERE guild_id = ? ORDER BY xp DESC LIMIT ? OFFSET ?');
const topPeriodStmt = prepare(`
  SELECT user_id, xp, messages, voice_xp FROM leveling_periods
  WHERE guild_id = ? AND period = ? AND xp > 0
  ORDER BY xp DESC LIMIT ? OFFSET ?
`);
const rankStmt = prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ? AND xp > ?');
const countStmt = prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ?');
const countPeriodStmt = prepare(
  'SELECT COUNT(*) AS n FROM leveling_periods WHERE guild_id = ? AND period = ? AND xp > 0'
);
const deleteGuildStmt = prepare('DELETE FROM leveling WHERE guild_id = ?');
const deleteGuildPeriodsStmt = prepare('DELETE FROM leveling_periods WHERE guild_id = ?');
const pruneWeekStmt = prepare("DELETE FROM leveling_periods WHERE period LIKE 'w:%' AND period < ?");
const pruneMonthStmt = prepare("DELETE FROM leveling_periods WHERE period LIKE 'm:%' AND period < ?");

const EMPTY = { xp: 0, level: 0, messages: 0, voice_xp: 0, voice_minutes: 0, last_msg_at: 0 };

export async function getMember(guildId, userId) {
  return (await getStmt.get(guildId, userId)) ?? { guild_id: guildId, user_id: userId, ...EMPTY };
}

// --- period keys -----------------------------------------------------------

/** ISO-8601 week string for a timestamp, e.g. "2026-W36" (UTC, Monday-based). */
export function isoWeek(at = Date.now()) {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  // Shift to the Thursday of this week — its calendar year is the ISO year.
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNo = 1 + Math.round(((d - week1) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** The `{ week, month }` period keys a timestamp belongs to. */
export function periodKeys(at = Date.now()) {
  const dt = new Date(at);
  const month = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  return { week: `w:${isoWeek(at)}`, month: `m:${month}` };
}

// --- writes --------------------------------------------------------------

/**
 * Add XP for a message (default) or a stretch of voice time (`voice: true`, with
 * `minutes` for the display counter). Updates the all-time row and the current
 * week + month period rows.
 *
 * Previously a `db.transaction()`-wrapped "read prev, compute in JS, write" —
 * better-sqlite3's transaction() requires a fully synchronous callback (any
 * `await` inside breaks its atomicity guarantee, since it can't tell "done"
 * from "suspended at the first await"), which the async `prepare()` shim
 * can't offer. Redesigned around atomic increments instead: `xp`/`messages`/
 * `voice_xp`/`voice_minutes` are bumped in one upsert that RETURNs the
 * post-increment row, and `previousLevel` is derived mathematically as
 * `levelFromXp(newXp - add)` — exactly the level as of just before *this*
 * call's own delta, correct regardless of what any concurrent caller does.
 * @returns {Promise<{ xp: number, level: number, leveledUp: boolean, previousLevel: number }>}
 */
export async function addXp(guildId, userId, amount, now = Date.now(), { voice = false, minutes = 0 } = {}) {
  const add = Math.max(0, Math.floor(amount));
  const msgInc = voice ? 0 : 1;
  const voiceInc = voice ? add : 0;
  const minsInc = voice ? Math.max(0, Math.round(minutes)) : 0;

  const row = await bumpStmt.get({
    guildId,
    userId,
    add,
    msgInc,
    voiceInc,
    minsInc,
    lastMsgAt: now,
    voice: voice ? 1 : 0,
  });
  const xp = Number(row.xp);
  const level = levelFromXp(xp);
  const previousLevel = levelFromXp(Math.max(0, xp - add));
  await setLevelIfHigherStmt.run({ guildId, userId, level });

  const { week, month } = periodKeys(now);
  for (const period of [week, month]) {
    await periodUpsertStmt.run({ guildId, userId, period, xp: add, messages: msgInc, voiceXp: voiceInc });
  }
  return { xp, level, leveledUp: level > previousLevel, previousLevel };
}

/** Force a member's XP to an exact value (dashboard correction). */
export async function setXp(guildId, userId, xpValue) {
  const xp = Math.max(0, Math.floor(Number(xpValue) || 0));
  const prev = await getMember(guildId, userId);
  await upsertStmt.run({
    guildId,
    userId,
    xp,
    level: levelFromXp(xp),
    messages: prev.messages,
    voiceXp: prev.voice_xp,
    voiceMinutes: prev.voice_minutes ?? 0,
    lastMsgAt: prev.last_msg_at,
  });
  return xp;
}

// --- reads --------------------------------------------------------------

export async function topMembers(guildId, limit = 15, offset = 0) {
  return topStmt.all(guildId, limit, offset);
}

/** Top members by XP earned within one period key (from {@link periodKeys}). */
export async function topMembersForPeriod(guildId, period, limit = 15, offset = 0) {
  return topPeriodStmt.all(guildId, period, limit, offset);
}

/** 1-based rank of a member within the guild by all-time XP. */
export async function memberRank(guildId, userId) {
  const me = await getMember(guildId, userId);
  return (Number((await rankStmt.get(guildId, me.xp))?.n) || 0) + 1;
}

export async function memberCount(guildId) {
  return Number((await countStmt.get(guildId))?.n) || 0;
}

export async function memberCountForPeriod(guildId, period) {
  return Number((await countPeriodStmt.get(guildId, period))?.n) || 0;
}

// --- maintenance ------------------------------------------------------

export async function resetGuildLeveling(guildId) {
  await deleteGuildStmt.run(guildId);
  await deleteGuildPeriodsStmt.run(guildId);
}

/** Drop period rows older than the retention window. */
export async function prunePeriods(keepWeeks = 10, keepMonths = 6, now = Date.now()) {
  await pruneWeekStmt.run(`w:${isoWeek(now - keepWeeks * 7 * 86_400_000)}`);
  const d = new Date(now);
  const cut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - keepMonths, 1));
  await pruneMonthStmt.run(`m:${cut.getUTCFullYear()}-${String(cut.getUTCMonth() + 1).padStart(2, '0')}`);
}
