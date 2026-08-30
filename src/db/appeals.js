// Ban-appeal submissions. One open appeal per (guild, user); history is kept
// after a decision so the cooldown check and the dashboard log can read it.
import { db } from './index.js';

const stmts = {
  insert: db.prepare(`
    INSERT INTO appeals (guild_id, user_id, user_tag, ban_reason, answers, status, created_at)
    VALUES (@guildId, @userId, @userTag, @banReason, @answers, 'open', @createdAt)
  `),
  open: db.prepare(
    "SELECT * FROM appeals WHERE guild_id = ? AND user_id = ? AND status = 'open'"
  ),
  latest: db.prepare(
    'SELECT * FROM appeals WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ),
  byId: db.prepare('SELECT * FROM appeals WHERE guild_id = ? AND id = ?'),
  list: db.prepare(
    'SELECT * FROM appeals WHERE guild_id = ? ORDER BY (status = \'open\') DESC, created_at DESC, id DESC LIMIT ?'
  ),
  countOpen: db.prepare(
    "SELECT COUNT(*) AS n FROM appeals WHERE guild_id = ? AND status = 'open'"
  ),
  decide: db.prepare(`
    UPDATE appeals
       SET status = @status, decided_by = @decidedBy, decision_reason = @reason, decided_at = @decidedAt
     WHERE guild_id = @guildId AND id = @id AND status = 'open'
  `),
  setInvite: db.prepare('UPDATE appeals SET invite_url = @url WHERE guild_id = @guildId AND id = @id'),
  clearGuild: db.prepare('DELETE FROM appeals WHERE guild_id = ?'),
};

/**
 * Create an appeal. Returns the new row id, or null if the user already has an
 * open appeal in this guild (the partial unique index rejects the insert).
 * @param {string} guildId
 * @param {{ userId: string, userTag?: string, banReason?: string, answers: Array<{ q: string, a: string }> }} data
 * @returns {number | null}
 */
export function createAppeal(guildId, { userId, userTag = '', banReason = '', answers }) {
  try {
    const info = stmts.insert.run({
      guildId,
      userId,
      userTag: String(userTag).slice(0, 100),
      banReason: String(banReason).slice(0, 500),
      answers: JSON.stringify(Array.isArray(answers) ? answers : []),
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return null;
    throw err;
  }
}

const parseAnswers = (row) => {
  if (!row) return row;
  let answers = [];
  try {
    answers = JSON.parse(row.answers) || [];
  } catch {
    answers = [];
  }
  return { ...row, answers };
};

export function getOpenAppeal(guildId, userId) {
  return parseAnswers(stmts.open.get(guildId, userId));
}

export function getLatestAppeal(guildId, userId) {
  return parseAnswers(stmts.latest.get(guildId, userId));
}

export function getAppeal(guildId, id) {
  return parseAnswers(stmts.byId.get(guildId, Number(id)));
}

export function listAppeals(guildId, limit = 100) {
  return stmts.list.all(guildId, limit).map(parseAnswers);
}

export function countOpenAppeals(guildId) {
  return stmts.countOpen.get(guildId).n;
}

/**
 * Resolve an open appeal.
 * @param {string} guildId
 * @param {number} id
 * @param {{ status: 'accepted' | 'denied', decidedBy: string, reason: string }} decision
 * @returns {boolean} true if a row was updated
 */
export function decideAppeal(guildId, id, { status, decidedBy, reason }) {
  const info = stmts.decide.run({
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
export function setAppealInvite(guildId, id, url) {
  stmts.setInvite.run({ guildId, id: Number(id), url: url || null });
}

export function clearGuildAppeals(guildId) {
  stmts.clearGuild.run(guildId);
}
