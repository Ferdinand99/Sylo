// The mod-log channel setting saves only a channel the bot can actually post embeds in.
// Used by the dashboard's server settings.

/** @returns {boolean} whether the bot can see, send and embed in that channel */
export function canPostInChannel(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  return Boolean(
    channel?.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])
  );
}
