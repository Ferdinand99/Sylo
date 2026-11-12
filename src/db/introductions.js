// Introductions storage: one row per member per server, holding the answers a member gave in
// the DM questionnaire and where their card was posted.
//
//   guild_id     the server key (a Discord id, or "fluxer:<id>"); named like every other table
//                so the guild-leave purge and /forget find it
//   user_id      the member
//   channel_id   the channel the card was posted in
//   message_id   the card message; NULL after the message was deleted (the answers stay, so
//                /intro can post the card again)
//   answers      JSON text: { "<question id>": "<answer>" }
//   created_at / updated_at   epoch ms
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS introductions (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    answers    TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_introductions_message ON introductions (guild_id, message_id);
`);

const s = {
  get: prepare('SELECT * FROM introductions WHERE guild_id = ? AND user_id = ?'),
  byMessage: prepare('SELECT * FROM introductions WHERE guild_id = ? AND message_id = ?'),
  upsert: prepare(`
    INSERT INTO introductions (guild_id, user_id, channel_id, message_id, answers, created_at, updated_at)
    VALUES (@guildId, @userId, @channelId, @messageId, @answers, @now, @now)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      answers    = excluded.answers,
      updated_at = excluded.updated_at
  `),
  clearMessage: prepare(
    'UPDATE introductions SET message_id = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?'
  ),
  del: prepare('DELETE FROM introductions WHERE guild_id = ? AND user_id = ?'),
  clearAnswers: prepare(
    "UPDATE introductions SET answers = '{}', updated_at = ? WHERE guild_id = ? AND user_id = ?"
  ),
  count: prepare('SELECT COUNT(*) AS n FROM introductions WHERE guild_id = ?'),
};

/** The stored answers of a row as an object (a damaged value reads as no answers). */
export function answersOf(row) {
  try {
    const parsed = JSON.parse(row?.answers ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const getIntroduction = async (guildId, userId) => (await s.get.get(guildId, userId)) ?? null;
export const getIntroductionByMessage = async (guildId, messageId) =>
  (await s.byMessage.get(guildId, messageId)) ?? null;

/**
 * Create or replace a member's introduction.
 * @param {{ guildId: string, userId: string, channelId: string, messageId?: string | null, answers: object }} row
 */
export async function saveIntroduction({ guildId, userId, channelId, messageId = null, answers }) {
  await s.upsert.run({
    guildId,
    userId,
    channelId,
    messageId: messageId ?? null,
    answers: JSON.stringify(answers ?? {}),
    now: Date.now(),
  });
}

/** Forget the card message (it was deleted); the answers stay. */
export const clearIntroductionMessage = async (guildId, userId) =>
  (await s.clearMessage.run(Date.now(), guildId, userId)).changes;

/**
 * Erase the answers but keep the row: the channel and message ids are what lets a card that could
 * not be deleted be deleted later.
 */
export const clearIntroductionAnswers = async (guildId, userId) =>
  (await s.clearAnswers.run(Date.now(), guildId, userId)).changes;

/** Delete a member's introduction. @returns {Promise<number>} rows removed */
export const deleteIntroduction = async (guildId, userId) => (await s.del.run(guildId, userId)).changes;

// COUNT(*) comes back as a string from postgres.js: coerce so both drivers agree.
export const introductionCount = async (guildId) => Number((await s.count.get(guildId)).n);
