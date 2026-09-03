// Helper for modules that post to a configured channel.
import { runtime } from '../../runtime.js';

/** Resolve a text-based channel the bot can post in, or null. Never throws. */
async function usableChannel(guildId, channelId) {
  if (!channelId) return null;
  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild) return null;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel?.isTextBased()) return null;
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return null;
    return channel;
  } catch {
    return null;
  }
}

/**
 * Send to a channel and return a reference to the message, or null on any
 * failure (missing channel, no permission, …). Never throws.
 * @returns {Promise<{ channelId: string, messageId: string } | null>}
 */
export async function postToChannel(guildId, channelId, payload) {
  const channel = await usableChannel(guildId, channelId);
  if (!channel) return null;
  try {
    const msg = await channel.send(payload);
    return { channelId, messageId: msg.id };
  } catch {
    return null;
  }
}

/**
 * Send content/embeds to a channel by id in a guild. No-op (never throws) when
 * the channel is missing, not text-based, or the bot lacks permission.
 * @returns {Promise<boolean>} whether the message was sent
 */
export async function sendToChannel(guildId, channelId, payload) {
  return (await postToChannel(guildId, channelId, payload)) != null;
}

/** Delete a message posted earlier. Quietly no-ops if it's already gone. */
export async function deleteChannelMessage(guildId, channelId, messageId) {
  if (!messageId) return false;
  const channel = await usableChannel(guildId, channelId);
  if (!channel) return false;
  try {
    await channel.messages.delete(messageId);
    return true;
  } catch {
    return false;
  }
}

/** Edit a message posted earlier. Quietly no-ops if it's gone / not ours. */
export async function editChannelMessage(guildId, channelId, messageId, payload) {
  if (!messageId) return false;
  const channel = await usableChannel(guildId, channelId);
  if (!channel) return false;
  try {
    await channel.messages.edit(messageId, payload);
    return true;
  } catch {
    return false;
  }
}
