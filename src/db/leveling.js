// Per-member XP / level state for the leveling module.
//
// Two rollups are kept in step by addXp():
//   - `leveling`          — all-time totals (xp, level, messages, voice_xp)
//   - `leveling_periods`  — one row per (member, period) where period is
//                           `w:<ISO-year>-W<ww>` or `m:<year>-<mm>`, powering the
//                           weekly / monthly leaderboards.
import { db } from './index.js';
import { levelFromXp } from '../modules/lib/levels.js';

const getStmt = db.prepare('SELECT * FROM leveling WHERE guild_id = ? AND user_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO leveling (guild_id, user_id, xp, level, messages, voice_xp, voice_minutes, last_msg_at)
  VALUES (@guildId, @userId, @xp, @level, @messages, @voiceXp, @voiceMinutes, @lastMsgAt)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = excluded.xp, level = excluded.level,
    messages = excluded.messages, voice_xp = excluded.voice_xp,
    voice_minutes = excluded.voice_minutes,
    last_msg_at = excluded.last_msg_at
`);
const periodUpsertStmt = db.prepare(`
  INSERT INTO leveling_periods (guild_id, user_id, period, xp, messages, voice_xp)
  VALUES (@guildId, @userId, @period, @xp, @messages, @voiceXp)
  ON CONFLICT (guild_id, user_id, period) DO UPDATE SET
    xp = xp + excluded.xp,
    messages = messages + excluded.messages,
    voice_xp = voice_xp + excluded.voice_xp
`);
const topStmt = db.prepare('SELECT * FROM leveling WHERE guild_id = ? ORDER BY xp DESC LIMIT ? OFFSET ?');
const topPeriodStmt = db.prepare(`
  SELECT user_id, xp, messages, voice_xp FROM leveling_periods
  WHERE guild_id = ? AND period = ? AND xp > 0
  ORDER BY xp DESC LIMIT ? OFFSET ?
`);
const rankStmt = db.prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ? AND xp > ?');
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ?');
const countPeriodStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM leveling_periods WHERE guild_id = ? AND period = ? AND xp > 0'
);
const deleteGuildStmt = db.prepare('DELETE FROM leveling WHERE guild_id = ?');
const deleteGuildPeriodsStmt = db.prepare('DELETE FROM leveling_periods WHERE guild_id = ?');
const pruneWeekStmt = db.prepare("DELETE FROM leveling_periods WHERE period LIKE 'w:%' AND period < ?");
const pruneMonthStmt = db.prepare("DELETE FROM leveling_periods WHERE period LIKE 'm:%' AND period < ?");

const EMPTY = { xp: 0, level: 0, messages: 0, voice_xp: 0, voice_minutes: 0, last_msg_at: 0 };

export function getMember(guildId, userId) {
  return getStmt.get(guildId, userId) ?? { guild_id: guildId, user_id: userId, ...EMPTY };
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

const addXpTxn = db.transaction((guildId, userId, amount, now, voice, minutes) => {
  const prev = getMember(guildId, userId);
  const add = Math.max(0, Math.floor(amount));
  const xp = prev.xp + add;
  const level = levelFromXp(xp);
  const msgInc = voice ? 0 : 1;
  const voiceInc = voice ? add : 0;
  const minsInc = voice ? Math.max(0, Math.round(minutes)) : 0;
  upsertStmt.run({
    guildId,
    userId,
    xp,
    level,
    messages: prev.messages + msgInc,
    voiceXp: prev.voice_xp + voiceInc,
    voiceMinutes: (prev.voice_minutes ?? 0) + minsInc,
    lastMsgAt: voice ? prev.last_msg_at : now,
  });
  const { week, month } = periodKeys(now);
  for (const period of [week, month]) {
    periodUpsertStmt.run({ guildId, userId, period, xp: add, messages: msgInc, voiceXp: voiceInc });
  }
  return { xp, level, leveledUp: level > prev.level, previousLevel: prev.level };
});

/**
 * Add XP for a message (default) or a stretch of voice time (`voice: true`, with
 * `minutes` for the display counter). Updates the all-time row and the current
 * week + month period rows.
 * @returns {{ xp: number, level: number, leveledUp: boolean, previousLevel: number }}
 */
export function addXp(guildId, userId, amount, now = Date.now(), { voice = false, minutes = 0 } = {}) {
  return addXpTxn(guildId, userId, amount, now, voice, minutes);
}

/** Force a member's XP to an exact value (dashboard correction). */
export function setXp(guildId, userId, xpValue) {
  const xp = Math.max(0, Math.floor(Number(xpValue) || 0));
  const prev = getMember(guildId, userId);
  upsertStmt.run({
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

export function topMembers(guildId, limit = 15, offset = 0) {
  return topStmt.all(guildId, limit, offset);
}

/** Top members by XP earned within one period key (from {@link periodKeys}). */
export function topMembersForPeriod(guildId, period, limit = 15, offset = 0) {
  return topPeriodStmt.all(guildId, period, limit, offset);
}

/** 1-based rank of a member within the guild by all-time XP. */
export function memberRank(guildId, userId) {
  const me = getMember(guildId, userId);
  return rankStmt.get(guildId, me.xp).n + 1;
}

export function memberCount(guildId) {
  return countStmt.get(guildId).n;
}

export function memberCountForPeriod(guildId, period) {
  return countPeriodStmt.get(guildId, period).n;
}

// --- maintenance ------------------------------------------------------

export function resetGuildLeveling(guildId) {
  deleteGuildStmt.run(guildId);
  deleteGuildPeriodsStmt.run(guildId);
}

/** Drop period rows older than the retention window. */
export function prunePeriods(keepWeeks = 10, keepMonths = 6, now = Date.now()) {
  pruneWeekStmt.run(`w:${isoWeek(now - keepWeeks * 7 * 86_400_000)}`);
  const d = new Date(now);
  const cut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - keepMonths, 1));
  pruneMonthStmt.run(`m:${cut.getUTCFullYear()}-${String(cut.getUTCMonth() + 1).padStart(2, '0')}`);
}
