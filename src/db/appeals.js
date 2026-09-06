// Ban-appeal submissions. One open appeal per (guild, user); history is kept
// after a decision so the cooldown check and the dashboard log can read it.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS appeals (
    id              SERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    user_tag        TEXT NOT NULL DEFAULT '',
    ban_reason      TEXT NOT NULL DEFAULT '',
    answers         TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'open',
    decided_by      TEXT,
    decision_reason TEXT,
    created_at      BIGINT NOT NULL,
    decided_at      BIGINT,
    invite_url      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_appeals_guild_status ON appeals (guild_id, status, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_open_user ON appeals (guild_id, user_id) WHERE status = 'open';
`);

const stmts = {
  insert: prepare(
    `
    INSERT INTO appeals (guild_id, user_id, user_tag, ban_reason, answers, status, created_at)
    VALUES (@guildId, @userId, @userTag, @banReason, @answers, 'open', @createdAt)
  `,
    { returningId: true }
  ),
  open: prepare("SELECT * FROM appeals WHERE guild_id = ? AND user_id = ? AND status = 'open'"),
  latest: prepare(
    'SELECT * FROM appeals WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ),
  byId: prepare('SELECT * FROM appeals WHERE guild_id = ? AND id = ?'),
  list: prepare(
    "SELECT * FROM appeals WHERE guild_id = ? ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT ?"
  ),
  countOpen: prepare("SELECT COUNT(*) AS n FROM appeals WHERE guild_id = ? AND status = 'open'"),
  decide: prepare(`
    UPDATE appeals
       SET status = @status, decided_by = @decidedBy, decision_reason = @reason, decided_at = @decidedAt
     WHERE guild_id = @guildId AND id = @id AND status = 'open'
  `),
  setInvite: prepare('UPDATE appeals SET invite_url = @url WHERE guild_id = @guildId AND id = @id'),
  clearGuild: prepare('DELETE FROM appeals WHERE guild_id = ?'),
};

// SQLite reports a unique-constraint violation as "UNIQUE constraint failed: …";
// Postgres reports it as "duplicate key value violates unique constraint …"
// (error code 23505) — neither driver's wording matches the other, so this
// checks both the code (Postgres) and a case-insensitive "unique" substring
// (matches both drivers' message text) rather than the old SQLite-only
// `.includes('UNIQUE')` check.
const isUniqueViolation = (err) => err.code === '23505' || /unique/i.test(String(err.message));

/**
 * Create an appeal. Returns the new row id, or null if the user already has an
 * open appeal in this guild (the partial unique index rejects the insert).
 * @param {string} guildId
 * @param {{ userId: string, userTag?: string, banReason?: string, answers: Array<{ q: string, a: string }> }} data
 * @returns {Promise<number | null>}
 */
export async function createAppeal(guildId, { userId, userTag = '', banReason = '', answers }) {
  try {
    const info = await stmts.insert.run({
      guildId,
      userId,
      userTag: String(userTag).slice(0, 100),
      banReason: String(banReason).slice(0, 500),
      answers: JSON.stringify(Array.isArray(answers) ? answers : []),
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

const parseAnswers = (row) => {
  if (!row) return row;
  let answers;
  try {
    answers = JSON.parse(row.answers) || [];
  } catch {
    answers = [];
  }
  return { ...row, answers };
};

export async function getOpenAppeal(guildId, userId) {
  return parseAnswers(await stmts.open.get(guildId, userId));
}

export async function getLatestAppeal(guildId, userId) {
  return parseAnswers(await stmts.latest.get(guildId, userId));
}

export async function getAppeal(guildId, id) {
  return parseAnswers(await stmts.byId.get(guildId, Number(id)));
}

export async function listAppeals(guildId, limit = 100) {
  return (await stmts.list.all(guildId, limit)).map(parseAnswers);
}

export async function countOpenAppeals(guildId) {
  // COUNT(*) comes back as a string from postgres.js (bigint safety) but a
  // plain number from better-sqlite3 — coerce so both drivers agree.
  return Number((await stmts.countOpen.get(guildId))?.n) || 0;
}

/**
 * Resolve an open appeal.
 * @param {string} guildId
 * @param {number} id
 * @param {{ status: 'accepted' | 'denied', decidedBy: string, reason: string }} decision
 * @returns {Promise<boolean>} true if a row was updated
 */
export async function decideAppeal(guildId, id, { status, decidedBy, reason }) {
  const info = await stmts.decide.run({
    guildId,
    id: Number(id),
    status,
    decidedBy: String(decidedBy).slice(0, 100),
    reason: String(reason).slice(0, 1000),
    decidedAt: Date.now(),
  });
  return info.changes > 0;
}

/** Store the single-use rejoin invite generated for an accepted appeal. */
export async function setAppealInvite(guildId, id, url) {
  await stmts.setInvite.run({ guildId, id: Number(id), url: url || null });
}

export async function clearGuildAppeals(guildId) {
  await stmts.clearGuild.run(guildId);
}
