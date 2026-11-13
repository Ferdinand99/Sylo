// Who has been welcomed in "when a member gets a role" mode (src/modules/welcome.js): one row per
// member per server, so the welcome is sent once however many trigger roles they gain.
//
//   guild_id   the server key (a Discord id, or "fluxer:<id>")
//   user_id    the member
//   sent_at    epoch ms, when the welcome was claimed
//
// The row is written before the welcome is sent (claim first), so two role events at the same
// moment cannot both send, and it stays when a send fails: a missed welcome is better than a
// double one. Leaving the server deletes the row, so a rejoin can be welcomed again.
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
  claim: prepare(
    'INSERT INTO welcome_sent (guild_id, user_id, sent_at) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO NOTHING'
  ),
  get: prepare('SELECT * FROM welcome_sent WHERE guild_id = ? AND user_id = ?'),
  del: prepare('DELETE FROM welcome_sent WHERE guild_id = ? AND user_id = ?'),
};

/**
 * Take the welcome for a member. True for the one caller that wrote the row; false when the member
 * was already welcomed (or another event claimed it a moment ago).
 */
export async function claimWelcome(guildId, userId, now = Date.now()) {
  return (await s.claim.run(guildId, userId, now)).changes === 1;
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
