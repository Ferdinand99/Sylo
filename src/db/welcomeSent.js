// Who has been welcomed (src/modules/welcome.js): one row per member per server, written by a welcome on
// joining and by one on a role gain, so a member is welcomed once however many trigger roles they gain,
// and a member welcomed on joining is not welcomed again by a role.
//
//   guild_id   the server key (a Discord id, or "fluxer:<id>")
//   user_id    the member
//   sent_at    epoch ms, when the welcome was claimed
//
// The row is written before the welcome is sent (claim first), so two role events at the same
// moment cannot both send, and it stays when a send fails: a missed welcome is better than a
// double one. Leaving the server deletes the row, so a rejoin can be welcomed again; when the leave was
// not seen (the module was off, Sylo was down) the next claim replaces a row older than the member's
// join time.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS welcome_sent (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    sent_at  BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);

const s = {
  // The row of an earlier membership (sent before this one began) is replaced; a fresh one is left alone,
  // so of two claims at the same moment only one reports a change, on SQLite and on Postgres.
  claim: prepare(
    `INSERT INTO welcome_sent (guild_id, user_id, sent_at) VALUES (?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET sent_at = excluded.sent_at
     WHERE welcome_sent.sent_at < ?`
  ),
  get: prepare('SELECT * FROM welcome_sent WHERE guild_id = ? AND user_id = ?'),
  del: prepare('DELETE FROM welcome_sent WHERE guild_id = ? AND user_id = ?'),
};

/**
 * How much earlier than the join time a row may be and still belong to this membership (clock skew
 * between the platform and this host). The other side of the margin: when a member leaves and rejoins and
 * the leave was never seen (the module was off, Sylo was down), a rejoin less than this long after the
 * previous welcome still counts as the same membership, and is not welcomed again.
 */
const SKEW_MS = 60_000;

/**
 * Take the welcome for a member. True for the one caller that wrote the row; false when the member
 * was already welcomed (or another event claimed it a moment ago).
 *
 * `joinedAt` is when the member joined, in epoch ms, when the platform says: a row sent more than a
 * minute before that belongs to an earlier membership (the leave was never seen), and is replaced.
 * Without it a row is never replaced.
 * @param {string} guildId
 * @param {string} userId
 * @param {{ joinedAt?: number | null, now?: number }} [opts]
 */
export async function claimWelcome(guildId, userId, { joinedAt = null, now = Date.now() } = {}) {
  const staleBefore = Number.isFinite(joinedAt) ? joinedAt - SKEW_MS : -1;
  return (await s.claim.run(guildId, userId, now, staleBefore)).changes === 1;
}

/** The claim row of a member, or null. */
export async function getWelcomeSent(guildId, userId) {
  const row = await s.get.get(guildId, userId);
  return row ? { ...row, sent_at: Number(row.sent_at) } : null;
}

/** Forget that a member was welcomed (they left the server). */
export async function clearWelcomeSent(guildId, userId) {
  await s.del.run(guildId, userId);
}
