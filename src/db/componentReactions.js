// What each reaction on a message does, for platforms that render buttons and
// select menus as reactions (see src/platform/components.js). A Discord button
// carries its customId inside the message; a reaction does not, so the mapping
// is stored here and survives a restart — verification panels, giveaways and
// reaction roles must keep working long after the bot that posted them stopped.
//
// `expires_at` is NULL for permanent panels; short-lived menus (a /help reply)
// set one and are swept by purgeExpiredComponentActions().
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS component_reactions (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    custom_id  TEXT NOT NULL,
    value      TEXT,
    expires_at BIGINT,
    PRIMARY KEY (message_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_component_reactions_expiry ON component_reactions (expires_at);
`);

const s = {
  insert: prepare(`
    INSERT INTO component_reactions (guild_id, channel_id, message_id, emoji, kind, custom_id, value, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  get: prepare('SELECT * FROM component_reactions WHERE message_id = ? AND emoji = ?'),
  delMessage: prepare('DELETE FROM component_reactions WHERE message_id = ?'),
  delExpired: prepare('DELETE FROM component_reactions WHERE expires_at IS NOT NULL AND expires_at <= ?'),
};

const fromRow = (r) => ({
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  kind: r.kind,
  customId: r.custom_id,
  value: r.value ?? null,
  emoji: r.emoji,
  expiresAt: r.expires_at ?? null,
});

/**
 * Store the actions of one message, replacing any it had before.
 * @param {{ guildId: string, channelId: string, messageId: string,
 *           actions: Array<{ kind: string, customId: string, value?: string, emoji: string }>,
 *           expiresAt?: number | null }} entry
 */
export async function saveComponentActions({ guildId, channelId, messageId, actions, expiresAt = null }) {
  await s.delMessage.run(messageId);
  for (const a of actions) {
    await s.insert.run(
      guildId,
      channelId,
      messageId,
      a.emoji,
      a.kind,
      a.customId,
      a.value ?? null,
      expiresAt
    );
  }
}

export async function getComponentAction(messageId, emoji) {
  const row = await s.get.get(messageId, emoji);
  return row ? fromRow(row) : null;
}

export const deleteComponentActions = async (messageId) => s.delMessage.run(messageId);
export const purgeExpiredComponentActions = async (now = Date.now()) => (await s.delExpired.run(now)).changes;
