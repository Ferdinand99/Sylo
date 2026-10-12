// Creating and deleting guild channels across platforms. discord.js has
// guild.channels.create() / .delete(); on Fluxer `guild.channels` is a plain
// Collection whose delete() only forgets the cached entry, so creation goes
// through the compat Guild#createChannelCompat and deletion through the channel
// itself.

/**
 * Create a channel from discord.js-style options
 * (`{ name, type, parent, permissionOverwrites, userLimit, bitrate, topic, reason }`).
 * @param {any} guild
 * @param {object} opts
 */
export function createGuildChannel(guild, opts) {
  return typeof guild.createChannelCompat === 'function'
    ? guild.createChannelCompat(opts)
    : guild.channels.create(opts);
}

/**
 * Delete a channel by id. Resolves quietly when the channel is already gone.
 * @param {any} guild
 * @param {string} channelId
 * @param {string} [reason]
 */
export async function deleteGuildChannel(guild, channelId, reason) {
  const cached = guild.channels.cache?.get(channelId);
  if (cached) return cached.delete(reason);
  // Not cached: discord.js can still delete by id; Fluxer has no way to without the channel.
  if (typeof guild.channels.delete === 'function' && guild.channels.cache)
    return guild.channels.delete(channelId, reason);
  return undefined;
}
