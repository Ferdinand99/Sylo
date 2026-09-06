// Invite tracker storage: per-member tallies (regular joins credited, leaves
// within the grace window, and a manual bonus) plus a row per joiner recording
// who invited them so a later leave can be attributed.
import { prepare, registerPostgresBootstrap } from './driver.js';

const NET = '(regular - leaves + bonus)';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS invite_counts (
    guild_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    regular   INTEGER NOT NULL DEFAULT 0,
    leaves    INTEGER NOT NULL DEFAULT 0,
    bonus     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invite_joins (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    inviter_id TEXT,
    code       TEXT,
    source     TEXT NOT NULL DEFAULT 'unknown',
    joined_at  BIGINT NOT NULL,
    counted    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invite_personal (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    code     TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_invite_counts_guild ON invite_counts (guild_id);
  CREATE INDEX IF NOT EXISTS idx_invite_personal_code ON invite_personal (guild_id, code);
`);

const stmts = {
  getCount: prepare('SELECT * FROM invite_counts WHERE guild_id = ? AND user_id = ?'),
  // The updated column is qualified with the table name — an unqualified
  // `regular = regular + @delta` is AMBIGUOUS on Postgres (error 42702): the
  // DO UPDATE SET scope sees both the target table's current row and the
  // proposed `excluded` row, both with a `regular` column. SQLite never
  // complains and just uses the current row, which is what we want, so
  // qualifying with the real table name (not an alias — none is declared on
  // the INSERT) is the portable fix for both drivers.
  bumpRegular: prepare(`
    INSERT INTO invite_counts (guild_id, user_id, regular) VALUES (@guildId, @userId, @delta)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET regular = invite_counts.regular + @delta
  `),
  bumpLeaves: prepare(`
    INSERT INTO invite_counts (guild_id, user_id, leaves) VALUES (@guildId, @userId, @delta)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET leaves = invite_counts.leaves + @delta
  `),
  setBonus: prepare(`
    INSERT INTO invite_counts (guild_id, user_id, bonus) VALUES (@guildId, @userId, @value)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET bonus = @value
  `),
  top: prepare(
    `SELECT *, ${NET} AS net FROM invite_counts WHERE guild_id = ? AND ${NET} > 0 ORDER BY net DESC, regular DESC LIMIT ?`
  ),
  // Aliased on both sides of the subquery — Postgres treats an unaliased
  // self-referencing subquery's bare columns as ambiguous between the outer
  // and inner scope (error 42702); SQLite silently resolves to the innermost
  // scope and never complained. Aliasing is standard SQL and works
  // identically on both drivers.
  rank: prepare(
    `SELECT COUNT(*) AS n FROM invite_counts outer_ic WHERE outer_ic.guild_id = ? AND (outer_ic.regular - outer_ic.leaves + outer_ic.bonus) > (SELECT (inner_ic.regular - inner_ic.leaves + inner_ic.bonus) FROM invite_counts inner_ic WHERE inner_ic.guild_id = ? AND inner_ic.user_id = ?)`
  ),
  inviterCount: prepare(`SELECT COUNT(*) AS n FROM invite_counts WHERE guild_id = ? AND ${NET} > 0`),
  recordJoin: prepare(`
    INSERT INTO invite_joins (guild_id, user_id, inviter_id, code, source, joined_at, counted)
    VALUES (@guildId, @userId, @inviterId, @code, @source, @joinedAt, @counted)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      inviter_id = excluded.inviter_id, code = excluded.code, source = excluded.source,
      joined_at = excluded.joined_at, counted = excluded.counted
  `),
  getJoin: prepare('SELECT * FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  deleteJoin: prepare('DELETE FROM invite_joins WHERE guild_id = ? AND user_id = ?'),
  getPersonal: prepare('SELECT * FROM invite_personal WHERE guild_id = ? AND user_id = ?'),
  ownerOfCode: prepare('SELECT user_id FROM invite_personal WHERE guild_id = ? AND code = ?'),
  setPersonal: prepare(`
    INSERT INTO invite_personal (guild_id, user_id, code) VALUES (@guildId, @userId, @code)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET code = excluded.code
  `),
  delCounts: prepare('DELETE FROM invite_counts WHERE guild_id = ?'),
  delJoins: prepare('DELETE FROM invite_joins WHERE guild_id = ?'),
  delPersonal: prepare('DELETE FROM invite_personal WHERE guild_id = ?'),
};

const ZERO = { regular: 0, leaves: 0, bonus: 0 };

export async function getInviteCount(guildId, userId) {
  const row = (await stmts.getCount.get(guildId, userId)) ?? { guild_id: guildId, user_id: userId, ...ZERO };
  return { ...row, net: row.regular - row.leaves + row.bonus };
}
export async function bumpRegular(guildId, userId, delta = 1) {
  await stmts.bumpRegular.run({ guildId, userId, delta });
}
export async function bumpLeaves(guildId, userId, delta = 1) {
  await stmts.bumpLeaves.run({ guildId, userId, delta });
}
export async function setBonus(guildId, userId, value) {
  await stmts.setBonus.run({ guildId, userId, value: Math.trunc(value) });
}
export async function topInviters(guildId, limit = 15) {
  return stmts.top.all(guildId, limit);
}
export async function inviterRank(guildId, userId) {
  return (Number((await stmts.rank.get(guildId, guildId, userId))?.n) || 0) + 1;
}
export async function inviterCount(guildId) {
  return Number((await stmts.inviterCount.get(guildId))?.n) || 0;
}
export async function recordJoin(
  guildId,
  userId,
  { inviterId = null, code = null, source = 'unknown', joinedAt, counted = 1 }
) {
  await stmts.recordJoin.run({
    guildId,
    userId,
    inviterId,
    code,
    source,
    joinedAt: joinedAt ?? Date.now(),
    counted,
  });
}
export async function getJoin(guildId, userId) {
  return (await stmts.getJoin.get(guildId, userId)) ?? null;
}
export async function deleteJoin(guildId, userId) {
  await stmts.deleteJoin.run(guildId, userId);
}
export async function getPersonalCode(guildId, userId) {
  return (await stmts.getPersonal.get(guildId, userId))?.code ?? null;
}
export async function personalCodeOwner(guildId, code) {
  return code ? ((await stmts.ownerOfCode.get(guildId, code))?.user_id ?? null) : null;
}
export async function setPersonalCode(guildId, userId, code) {
  await stmts.setPersonal.run({ guildId, userId, code });
}
export async function clearGuildInvites(guildId) {
  await stmts.delCounts.run(guildId);
  await stmts.delJoins.run(guildId);
  await stmts.delPersonal.run(guildId);
}
