// Fluxer's gateway events are not shaped like discord.js's. This turns them
// into the shape the platform-neutral code (reactionBridge.js) expects.
//
// What the live SDK does that discord.js does not (found against a real
// instance):
//   - messageReactionAdd emits ONE payload object, not (reaction, user)
//   - a message the bot sent itself has no guild id (the REST response omits
//     it), so message.guild is null and the message looks like a DM
//   - reactions are removed through the message: message.removeReaction(emoji, userId)

const emojiId = (emoji) => (emoji?.id ? `${emoji.name}:${emoji.id}` : emoji?.name);

/** Give a message its guild when the SDK left it out. */
function withGuild(client, message, guildId) {
  if (!guildId) return message;
  if (message.guildId == null)
    Object.defineProperty(message, 'guildId', { value: guildId, configurable: true, writable: true });
  if (!message.guild) {
    Object.defineProperty(message, 'guild', {
      value: client.guilds.cache.get(guildId) ?? null,
      configurable: true,
      writable: true,
    });
  }
  return message;
}

/**
 * @param {any} client  the Fluxer client
 * @param {any} payload  the messageReactionAdd payload
 * @returns {Promise<{ reaction: any, user: any } | null>}  null for Sylo's own reactions, or when the message or user can't be resolved
 */
export async function fluxerReactionAdd(client, payload) {
  if (payload.userId && payload.userId === client.user?.id) return null; // Sylo's own reactions
  const channel = payload.channel ?? client.channels.cache.get(payload.channelId);
  const guildId = payload.reaction?.guildId ?? channel?.guildId ?? null;

  let message;
  try {
    message = payload.message ?? payload.reaction?.message ?? (await payload.reaction?.fetchMessage?.());
  } catch {
    return null; // deleted, or not visible to the bot
  }
  if (!message) return null;
  const user = payload.user ?? (await client.users.fetch(payload.userId).catch(() => null));
  if (!user) return null;

  withGuild(client, message, guildId);
  const emoji = payload.emoji ?? payload.reaction?.emoji;
  const reaction = {
    emoji,
    message,
    users: { remove: (userId) => message.removeReaction(emojiId(emoji), userId) },
  };
  return { reaction, user };
}
