// Invite tracker storage: per-member tallies (regular joins credited, leaves
// within the grace window, and a manual bonus) plus a row per joiner recording
// who invited them so a later leave can be attributed.
import { db } from './index.js';

const NET = '(regular - leaves + bonus)';

const stmts = {
  getCount: db.prepare('SELECT * FROM invite_counts WHERE guild_id = ? AND user_id = ?'),
  bumpRegular: db.prepare(`
    INSERT INTO invite_counts (guild_id, user_id, regular) VALUES (@guildId, @userId, @delta)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET regular = regular + @delta
  `),
  bumpLeaves: db.prepare(`
    INSERT INTO invite_counts (guild_id, user_id, leaves) VALUES (@guildId, @userId, @delta)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET leaves = leaves + @delta
  `),
  setBonus: db.prepare(`
    INSERT INTO invite_counts (guild_id, user_id, bonus) VALUES (@guildId, @userId, @value)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET bonus = @value
  `),
  top: db.prepare(
    `SELECT *, ${NET} AS net FROM invite_counts WHERE guild_id = ? AND ${NET} > 0 ORDER BY net DESC, regular DESC LIMIT ?`
  ),
  rank: db.prepare(
    `SELECT COUNT(*) AS n FROM invite_counts WHERE guild_id = ? AND ${NET} > (SELECT ${NET} FROM invite_counts WHERE guild_id = ? AND user_id = ?)`
  ),
  inviterCount: db.prepare(`SELECT COUNT(*) AS n FROM invite_counts WHERE guild_id = ? AND ${NET} > 0`),
  recordJoin: db.prepare(`
    INSERT INTO invite_joins (guild_id, user_id, inviter_id, code, source, joined_at, counted)
    VALUES (@guildId, @userId, @inviterId, @code, @source, @joinedAt, @counted)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      inviter_id = excluded.inviter_id, code = excluded.code, source = excluded.source,
      joined_at = excluded.joined_at, counted = excluded.counted
  `),
  getJoin: db.prepare('SELECT * FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  deleteJoin: db.prepare('DELETE FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  getPersonal: db.prepare('SELECT * FROM invite_personal WHERE guild_id = ? AND user_id = ?'),
  ownerOfCode: db.prepare('SELECT user_id FROM invite_personal WHERE guild_id = ? AND code = ?'),
  setPersonal: db.prepare(`
    INSERT INTO invite_personal (guild_id, user_id, code) VALUES (@guildId, @userId, @code)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET code = excluded.code
  `),
  delCounts: db.prepare('DELETE FROM invite_counts WHERE guild_id = ?'),
  delJoins: db.prepare('DELETE FROM invite_joins WHERE guild_id = ?'),
  delPersonal: db.prepare('DELETE FROM invite_personal WHERE guild_id = ?'),
};

const ZERO = { regular: 0, leaves: 0, bonus: 0 };

export function getInviteCount(guildId, userId) {
  const row = stmts.getCount.get(guildId, userId) ?? { guild_id: guildId, user_id: userId, ...ZERO };
  return { ...row, net: row.regular - row.leaves + row.bonus };
}
export function bumpRegular(guildId, userId, delta = 1) {
  stmts.bumpRegular.run({ guildId, userId, delta });
}
export function bumpLeaves(guildId, userId, delta = 1) {
  stmts.bumpLeaves.run({ guildId, userId, delta });
}
export function setBonus(guildId, userId, value) {
  stmts.setBonus.run({ guildId, userId, value: Math.trunc(value) });
}
export function topInviters(guildId, limit = 15) {
  return stmts.top.all(guildId, limit);
}
export function inviterRank(guildId, userId) {
  return (stmts.rank.get(guildId, guildId, userId)?.n ?? 0) + 1;
}
export function inviterCount(guildId) {
  return stmts.inviterCount.get(guildId)?.n ?? 0;
}
export function recordJoin(
  guildId,
  userId,
  { inviterId = null, code = null, source = 'unknown', joinedAt, counted = 1 }
) {
  stmts.recordJoin.run({
    guildId,
    userId,
    inviterId,
    code,
    source,
    joinedAt: joinedAt ?? Date.now(),
    counted,
  });
}
export function getJoin(guildId, userId) {
  return stmts.getJoin.get(guildId, userId) ?? null;
}
export function deleteJoin(guildId, userId) {
  stmts.deleteJoin.run(guildId, userId);
}
export function getPersonalCode(guildId, userId) {
  return stmts.getPersonal.get(guildId, userId)?.code ?? null;
}
export function personalCodeOwner(guildId, code) {
  return code ? (stmts.ownerOfCode.get(guildId, code)?.user_id ?? null) : null;
}
export function setPersonalCode(guildId, userId, code) {
  stmts.setPersonal.run({ guildId, userId, code });
}
export function clearGuildInvites(guildId) {
  stmts.delCounts.run(guildId);
  stmts.delJoins.run(guildId);
  stmts.delPersonal.run(guildId);
}
