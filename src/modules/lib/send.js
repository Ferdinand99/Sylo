// Helper for modules that post to a configured channel.
import { runtime } from '../../runtime.js';

/**
 * Send content/embeds to a channel by id in a guild. No-op (never throws) when
 * the channel is missing, not text-based, or the bot lacks permission.
 * @param {string} guildId
 * @param {string} channelId
 * @param {import('discord.js').MessageCreateOptions} payload
 * @returns {Promise<boolean>} whether the message was sent
 */
export async function sendToChannel(guildId, channelId, payload) {
  if (!channelId) return false;
  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild) return false;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel?.isTextBased()) return false;
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return false;
    await channel.send(payload);
    return true;
  } catch {
    // Channel deleted / perms changed — best-effort.
    return false;
  }
}
