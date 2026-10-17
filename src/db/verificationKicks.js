// Pending "kick if not verified" deadlines (the verification module's kickAfterMinutes). Stored,
// not kept in a timer, so a restart does not forget them.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS verification_kicks (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    due_at   BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_verification_kicks_due ON verification_kicks (due_at);
`);

const s = {
  upsert: prepare(`
    INSERT INTO verification_kicks (guild_id, user_id, due_at) VALUES (@guildId, @userId, @dueAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET due_at = excluded.due_at
  `),
  due: prepare('SELECT * FROM verification_kicks WHERE due_at <= ? ORDER BY due_at LIMIT 500'),
  del: prepare('DELETE FROM verification_kicks WHERE guild_id = ? AND user_id = ?'),
};

export async function scheduleVerificationKick({ guildId, userId, dueAt }) {
  await s.upsert.run({ guildId, userId, dueAt });
}

/** @returns {Promise<Array<{ guild_id: string, user_id: string, due_at: number }>>} */
export async function dueVerificationKicks(now = Date.now()) {
  return (await s.due.all(now)).map((r) => ({ ...r, due_at: Number(r.due_at) }));
}

export async function clearVerificationKick(guildId, userId) {
  await s.del.run(guildId, userId);
}
