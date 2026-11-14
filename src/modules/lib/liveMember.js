// A member as the platform has them now, for a decision about which roles they hold.
//
// Without the Server Members intent (INTENT_GUILD_MEMBERS=false) Discord does not tell the bot when a
// member's roles change, and discord.js does not update its cached member when the bot adds or
// removes a role itself: the cache keeps the roles from when the member was first seen. A decision
// to leave a role alone ("they do not have it") must not rest on that, so the member is fetched
// fresh. With the intent the cache is kept current and is used as it is.
import { config } from '../../config.js';
import { platformOfGuild } from '../../platform/platformOf.js';

/** Is the guild's member cache kept current by the gateway? */
export const memberCacheIsCurrent = (guild) =>
  platformOfGuild(guild) !== 'discord' || config.intentGuildMembers !== false;

/**
 * The member now. Rejects when the platform says the member is gone (the caller decides what that means).
 * @returns {Promise<import('discord.js').GuildMember>}
 */
export async function liveMember(guild, userId) {
  if (memberCacheIsCurrent(guild)) return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
  return guild.members.fetch({ user: userId, force: true });
}
