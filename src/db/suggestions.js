// Suggestions storage: a row per suggestion (numbered per server), a row per vote.
//
//   number     the server's own sequential number, shown as #12 (not the table id)
//   status     'open' | 'considering' | 'approved' | 'denied' | 'implemented'
//   author_id  NULL after the author used /forget: the text stays, the person does not
//   anonymous  1 when the post was made without showing the author
//   vote       1 (up) or -1 (down); taking a vote back deletes the row
import { prepare, registerPostgresBootstrap, registerPostgresMigration } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_suggestions (
    id          SERIAL PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    number      INTEGER NOT NULL,
    channel_id  TEXT NOT NULL,
    message_id  TEXT,
    author_id   TEXT,
    anonymous   INTEGER NOT NULL DEFAULT 0,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    reason      TEXT NOT NULL DEFAULT '',
    decided_by  TEXT,
    decided_at  BIGINT,
    created_at  BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_suggestions_number ON guild_suggestions (guild_id, number);
  CREATE INDEX IF NOT EXISTS idx_guild_suggestions_author ON guild_suggestions (guild_id, author_id);
  CREATE TABLE IF NOT EXISTS guild_suggestion_votes (
    suggestion_id INTEGER NOT NULL,
    user_id       TEXT NOT NULL,
    vote          INTEGER NOT NULL,
    updated_at    BIGINT NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_suggestion_votes_user ON guild_suggestion_votes (user_id);
  CREATE TABLE IF NOT EXISTS guild_suggestion_counters (
    guild_id    TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL
  );
`);

// Mirrors SQLite migration 59: start each server's counter at the highest number already used.
registerPostgresMigration(
  59,
  `INSERT INTO guild_suggestion_counters (guild_id, last_number)
     SELECT guild_id, MAX(number) FROM guild_suggestions GROUP BY guild_id
     ON CONFLICT (guild_id) DO NOTHING;`
);

export const STATUSES = ['open', 'considering', 'approved', 'denied', 'implemented'];

const VOTES = `
  (SELECT COUNT(*) FROM guild_suggestion_votes v WHERE v.suggestion_id = s.id AND v.vote = 1) AS up,
  (SELECT COUNT(*) FROM guild_suggestion_votes v WHERE v.suggestion_id = s.id AND v.vote = -1) AS down
`;

const s = {
  create: prepare(
    `
    INSERT INTO guild_suggestions (guild_id, number, channel_id, author_id, anonymous, title, body, created_at)
    VALUES (@guildId, @number, @channelId, @authorId, @anonymous, @title, @body, @createdAt)
  `,
    { returningId: true }
  ),
  bump: prepare(`
    INSERT INTO guild_suggestion_counters (guild_id, last_number) VALUES (?, 1)
    ON CONFLICT (guild_id) DO UPDATE SET last_number = guild_suggestion_counters.last_number + 1
  `),
  counter: prepare('SELECT last_number FROM guild_suggestion_counters WHERE guild_id = ?'),
  delCounter: prepare('DELETE FROM guild_suggestion_counters WHERE guild_id = ?'),
  numberOf: prepare('SELECT number FROM guild_suggestions WHERE id = ?'),
  setMessage: prepare('UPDATE guild_suggestions SET channel_id = ?, message_id = ? WHERE id = ?'),
  get: prepare(`SELECT s.*, ${VOTES} FROM guild_suggestions s WHERE s.id = ?`),
  getByNumber: prepare(`SELECT s.*, ${VOTES} FROM guild_suggestions s WHERE s.guild_id = ? AND s.number = ?`),
  countGuild: prepare('SELECT COUNT(*) AS n FROM guild_suggestions WHERE guild_id = ?'),
  countOpen: prepare(
    "SELECT COUNT(*) AS n FROM guild_suggestions WHERE guild_id = ? AND status IN ('open', 'considering')"
  ),
  countOpenByAuthor: prepare(
    "SELECT COUNT(*) AS n FROM guild_suggestions WHERE guild_id = ? AND author_id = ? AND status IN ('open', 'considering')"
  ),
  lastByAuthor: prepare(
    'SELECT MAX(created_at) AS t FROM guild_suggestions WHERE guild_id = ? AND author_id = ?'
  ),
  decide: prepare(
    'UPDATE guild_suggestions SET status = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ?'
  ),
  del: prepare('DELETE FROM guild_suggestions WHERE id = ?'),
  delVotes: prepare('DELETE FROM guild_suggestion_votes WHERE suggestion_id = ?'),
  delGuildVotes: prepare(
    'DELETE FROM guild_suggestion_votes WHERE suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = ?)'
  ),
  delGuild: prepare('DELETE FROM guild_suggestions WHERE guild_id = ?'),

  setVote: prepare(`
    INSERT INTO guild_suggestion_votes (suggestion_id, user_id, vote, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at
  `),
  removeVote: prepare('DELETE FROM guild_suggestion_votes WHERE suggestion_id = ? AND user_id = ?'),
  getVote: prepare('SELECT vote FROM guild_suggestion_votes WHERE suggestion_id = ? AND user_id = ?'),
  tally: prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS down
    FROM guild_suggestion_votes WHERE suggestion_id = ?
  `),
};

// The list statements differ only in a fixed filter and a fixed order, never in user text, so
// they are built once per combination.
const lists = {};
function listStmt(status, sort) {
  const key = `${status}/${sort}`;
  if (!lists[key]) {
    const filter =
      status === 'all'
        ? ''
        : status === 'open'
          ? "AND s.status IN ('open', 'considering')"
          : 'AND s.status = ?';
    const order =
      sort === 'top'
        ? '(SELECT COALESCE(SUM(v.vote), 0) FROM guild_suggestion_votes v WHERE v.suggestion_id = s.id) DESC, s.number DESC'
        : 's.number DESC';
    lists[key] = prepare(
      `SELECT s.*, ${VOTES} FROM guild_suggestions s WHERE s.guild_id = ? ${filter} ORDER BY ${order} LIMIT ?`
    );
  }
  return lists[key];
}

const hydrate = (row) => {
  if (!row) return null;
  // Postgres hands BIGINT and COUNT back as text on some paths; downstream treats them as numbers.
  return {
    ...row,
    number: Number(row.number),
    anonymous: row.anonymous === 1 || row.anonymous === '1',
    decided_at: row.decided_at == null ? null : Number(row.decided_at),
    created_at: Number(row.created_at),
    ...(row.up === undefined ? {} : { up: Number(row.up), down: Number(row.down) }),
  };
};

/**
 * Take the server's next suggestion number. It comes from a counter that only goes up, so a number
 * is never handed out twice, not even after the suggestion that had it was deleted. Callers hold
 * the server's lock (modules/suggestions.js), so the bump and the read cannot interleave.
 */
async function takeSuggestionNumber(guildId) {
  await s.bump.run(guildId);
  return Number((await s.counter.get(guildId)).last_number);
}

/**
 * Store a new suggestion with the server's next number.
 * @param {{ guildId: string, channelId: string, authorId: string, anonymous?: boolean, title?: string,
 *   body: string, createdAt?: number }} e
 * @returns {Promise<{ id: number, number: number }>}
 */
export async function createSuggestion(e) {
  const info = await s.create.run({
    guildId: e.guildId,
    number: await takeSuggestionNumber(e.guildId),
    channelId: e.channelId,
    authorId: e.authorId,
    anonymous: e.anonymous ? 1 : 0,
    title: e.title ?? '',
    body: e.body,
    createdAt: e.createdAt ?? Date.now(),
  });
  const id = Number(info.lastInsertRowid);
  return { id, number: Number((await s.numberOf.get(id)).number) };
}

/** Remember where the post is (also used when it moves to the log channel). */
export const setSuggestionMessage = async (id, channelId, messageId) =>
  s.setMessage.run(channelId, messageId, id);
export const getSuggestion = async (id) => hydrate(await s.get.get(id));
export const getSuggestionByNumber = async (guildId, number) =>
  hydrate(await s.getByNumber.get(guildId, number));
/** Only a suggestion of this server, or null. */
export async function getSuggestionInGuild(id, guildId) {
  const row = await getSuggestion(id);
  return row && row.guild_id === guildId ? row : null;
}
export const suggestionCount = async (guildId) => Number((await s.countGuild.get(guildId))?.n) || 0;
/** Suggestions still waiting for a decision (open or being considered). */
export const openSuggestionCount = async (guildId) => Number((await s.countOpen.get(guildId))?.n) || 0;
export const openSuggestionCountOf = async (guildId, authorId) =>
  Number((await s.countOpenByAuthor.get(guildId, authorId))?.n) || 0;
/** When this member last made a suggestion (epoch ms), or 0. */
export const lastSuggestionAtOf = async (guildId, authorId) =>
  Number((await s.lastByAuthor.get(guildId, authorId))?.t) || 0;

/**
 * Suggestions of a server with their vote counts.
 * @param {string} guildId
 * @param {{ status?: 'all'|'open'|'considering'|'approved'|'denied'|'implemented', sort?: 'new'|'top', limit?: number }} [opts]
 *   `open` covers open and considering.
 */
export async function listSuggestions(guildId, { status = 'all', sort = 'new', limit = 100 } = {}) {
  const st = status === 'all' || status === 'open' || STATUSES.includes(status) ? status : 'all';
  const order = sort === 'top' ? 'top' : 'new';
  const rows =
    st === 'all' || st === 'open'
      ? await listStmt(st, order).all(guildId, limit)
      : await listStmt(st, order).all(guildId, st, limit);
  return rows.map(hydrate);
}

/** Save a staff decision. */
export const decideSuggestion = async (
  id,
  { status, reason = '', decidedBy = null, decidedAt = Date.now() }
) => s.decide.run(status, reason, decidedBy, decidedAt, id);

/** Remove a suggestion and its votes. */
export async function deleteSuggestion(id) {
  await s.delVotes.run(id);
  await s.del.run(id);
}

export const setSuggestionVote = async (id, userId, vote) => s.setVote.run(id, userId, vote, Date.now());
export const removeSuggestionVote = async (id, userId) => s.removeVote.run(id, userId);
/** 1, -1, or 0 for no vote. */
export const getSuggestionVote = async (id, userId) => Number((await s.getVote.get(id, userId))?.vote) || 0;
/** @returns {Promise<{ up: number, down: number }>} */
export async function voteTally(id) {
  const row = await s.tally.get(id);
  return { up: Number(row?.up) || 0, down: Number(row?.down) || 0 };
}

export async function clearGuildSuggestions(guildId) {
  await s.delGuildVotes.run(guildId);
  await s.delGuild.run(guildId);
  await s.delCounter.run(guildId);
}
