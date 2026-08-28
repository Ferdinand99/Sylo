// Posts moderation actions to a guild's configured mod-log channel, if any.
import { getGuildSettings } from '../../db/guildSettings.js';

/**
 * Send an embed to the guild's mod-log channel. No-op when unconfigured or the
 * channel is missing/unusable. Never throws.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').EmbedBuilder} embed
 */
export async function postModLog(guild, embed) {
  const channelId = getGuildSettings(guild.id)?.modlog_channel_id;
  if (!channelId) return;

  try {
    const channel =
      guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel?.isTextBased()) return;

    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return;
    }
    await channel.send({ embeds: [embed] });
  } catch {
    // Channel deleted, permissions changed, etc. — logging is best-effort.
  }
}
