// Quote board storage: a row per saved quote, numbered per server, and a counter row per server
// that hands out the numbers.
//
//   number         the server's own sequential number, shown as #12. It comes from
//                  guild_quote_counters, which only goes up, so a number is never given out
//                  twice, not even after the quote that had it was deleted.
//   author_id      who wrote the message (a quote is deleted when this person uses /forget)
//   author_name    their display name when the quote was saved
//   body           the message text, cut to the limit; '' when the message was attachments only
//   attachments    how many files the message had (counted, never copied)
//   saved_by       who saved it; NULL after that person used /forget (the quote stays)
//   public_source  1 when @everyone could read the channel it came from, so the public page may
//                  show it; 0 for a hidden or age-restricted channel (or when that was unknown)
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_quotes (
    id            SERIAL PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    number        INTEGER NOT NULL,
    channel_id    TEXT NOT NULL,
    message_id    TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    author_name   TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    attachments   INTEGER NOT NULL DEFAULT 0,
    message_at    BIGINT NOT NULL,
    saved_by      TEXT,
    saved_at      BIGINT NOT NULL,
    public_source INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_quotes_number ON guild_quotes (guild_id, number);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_quotes_message ON guild_quotes (guild_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_guild_quotes_author ON guild_quotes (guild_id, author_id);
  CREATE INDEX IF NOT EXISTS idx_guild_quotes_saver ON guild_quotes (guild_id, saved_by);
  CREATE TABLE IF NOT EXISTS guild_quote_counters (
    guild_id    TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL
  );
`);

const COLUMNS = `guild_id, number, channel_id, message_id, author_id, author_name, body, attachments,
  message_at, saved_by, saved_at, public_source`;

const s = {
  bump: prepare(`
    INSERT INTO guild_quote_counters (guild_id, last_number) VALUES (?, 1)
    ON CONFLICT (guild_id) DO UPDATE SET last_number = guild_quote_counters.last_number + 1
  `),
  counter: prepare('SELECT last_number FROM guild_quote_counters WHERE guild_id = ?'),
  insert: prepare(
    `INSERT INTO guild_quotes (${COLUMNS}) VALUES (@guildId, @number, @channelId, @messageId, @authorId,
      @authorName, @body, @attachments, @messageAt, @savedBy, @savedAt, @publicSource)`,
    { returningId: true }
  ),
  byNumber: prepare('SELECT * FROM guild_quotes WHERE guild_id = ? AND number = ?'),
  byMessage: prepare('SELECT * FROM guild_quotes WHERE guild_id = ? AND message_id = ?'),
  count: prepare('SELECT COUNT(*) AS n FROM guild_quotes WHERE guild_id = ?'),
  countAuthor: prepare('SELECT COUNT(*) AS n FROM guild_quotes WHERE guild_id = ? AND author_id = ?'),
  countPublic: prepare('SELECT COUNT(*) AS n FROM guild_quotes WHERE guild_id = ? AND public_source = 1'),
  atOffset: prepare('SELECT * FROM guild_quotes WHERE guild_id = ? ORDER BY number LIMIT 1 OFFSET ?'),
  atOffsetAuthor: prepare(
    'SELECT * FROM guild_quotes WHERE guild_id = ? AND author_id = ? ORDER BY number LIMIT 1 OFFSET ?'
  ),
  byAuthor: prepare(
    'SELECT * FROM guild_quotes WHERE guild_id = ? AND author_id = ? ORDER BY number DESC LIMIT ?'
  ),
  recent: prepare('SELECT * FROM guild_quotes WHERE guild_id = ? ORDER BY number DESC LIMIT ? OFFSET ?'),
  recentPublic: prepare(
    'SELECT * FROM guild_quotes WHERE guild_id = ? AND public_source = 1 ORDER BY number DESC LIMIT ? OFFSET ?'
  ),
  search: prepare(
    `SELECT * FROM guild_quotes WHERE guild_id = ?
       AND (LOWER(body) LIKE ? ESCAPE '!' OR LOWER(author_name) LIKE ? ESCAPE '!')
     ORDER BY number DESC LIMIT ?`
  ),
  del: prepare('DELETE FROM guild_quotes WHERE id = ?'),
  delGuild: prepare('DELETE FROM guild_quotes WHERE guild_id = ?'),
  delCounter: prepare('DELETE FROM guild_quote_counters WHERE guild_id = ?'),
};

// Postgres hands BIGINT back as text on some paths; downstream treats them as numbers.
const hydrate = (row) =>
  row
    ? {
        ...row,
        number: Number(row.number),
        attachments: Number(row.attachments),
        message_at: Number(row.message_at),
        saved_at: Number(row.saved_at),
        public_source: row.public_source === 1 || row.public_source === '1' ? 1 : 0,
      }
    : null;

/** A LIKE pattern that matches `text` anywhere, with the wildcards in it taken literally. */
export const likePattern = (text) => `%${String(text).toLowerCase().replace(/[!%_]/g, '!$&')}%`;

/**
 * Take the server's next quote number. Callers hold the server's lock (modules/quoteBoard.js), so
 * the bump and the read cannot interleave.
 */
export async function takeQuoteNumber(guildId) {
  await s.bump.run(guildId);
  return Number((await s.counter.get(guildId)).last_number);
}

/**
 * Store a quote under the server's next number.
 * @param {{ guildId: string, channelId: string, messageId: string, authorId: string, authorName?: string,
 *   body?: string, attachments?: number, messageAt: number, savedBy?: string|null, savedAt?: number,
 *   publicSource?: boolean }} q
 * @returns {Promise<{ id: number, number: number }>}
 */
export async function insertQuote(q) {
  const number = await takeQuoteNumber(q.guildId);
  const info = await s.insert.run({
    guildId: q.guildId,
    number,
    channelId: q.channelId,
    messageId: q.messageId,
    authorId: q.authorId,
    authorName: q.authorName ?? '',
    body: q.body ?? '',
    attachments: q.attachments ?? 0,
    messageAt: q.messageAt,
    savedBy: q.savedBy ?? null,
    savedAt: q.savedAt ?? Date.now(),
    publicSource: q.publicSource ? 1 : 0,
  });
  return { id: Number(info.lastInsertRowid), number };
}

export const getQuoteByNumber = async (guildId, number) => hydrate(await s.byNumber.get(guildId, number));
export const getQuoteByMessage = async (guildId, messageId) =>
  hydrate(await s.byMessage.get(guildId, messageId));
export const quoteCount = async (guildId) => Number((await s.count.get(guildId))?.n) || 0;
export const quoteCountOf = async (guildId, authorId) =>
  Number((await s.countAuthor.get(guildId, authorId))?.n) || 0;
export const publicQuoteCount = async (guildId) => Number((await s.countPublic.get(guildId))?.n) || 0;

/**
 * One quote of the server picked by `pick` (a number in [0, 1), Math.random by default), or null
 * when there is none. With `authorId`, only that member's.
 */
export async function randomQuote(guildId, { authorId = null, pick = Math.random() } = {}) {
  const n = authorId ? await quoteCountOf(guildId, authorId) : await quoteCount(guildId);
  if (!n) return null;
  const offset = Math.min(n - 1, Math.max(0, Math.floor(pick * n)));
  return hydrate(
    authorId ? await s.atOffsetAuthor.get(guildId, authorId, offset) : await s.atOffset.get(guildId, offset)
  );
}

/** A member's quotes, newest first. */
export async function quotesByAuthor(guildId, authorId, limit = 10) {
  return (await s.byAuthor.all(guildId, authorId, limit)).map(hydrate);
}

/** The newest quotes, `offset` rows in. */
export async function recentQuotes(guildId, { limit = 50, offset = 0 } = {}) {
  return (await s.recent.all(guildId, limit, offset)).map(hydrate);
}

/** The newest quotes the public page may show (saved from channels everyone can read). */
export async function recentPublicQuotes(guildId, { limit = 50, offset = 0 } = {}) {
  return (await s.recentPublic.all(guildId, limit, offset)).map(hydrate);
}

/** Quotes whose text or author name contains `text`, newest first. */
export async function searchQuotes(guildId, text, limit = 5) {
  const pattern = likePattern(text);
  return (await s.search.all(guildId, pattern, pattern, limit)).map(hydrate);
}

export const deleteQuote = async (id) => s.del.run(id);

export async function clearGuildQuotes(guildId) {
  await s.delGuild.run(guildId);
  await s.delCounter.run(guildId);
}
