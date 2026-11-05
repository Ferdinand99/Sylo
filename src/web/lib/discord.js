// Helpers for reading Discord state from the shared client in web routes.
import { ChannelType } from 'discord.js';

const TEXTY = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/**
 * Text channels of a guild that the bot could post logs to, sorted the way
 * Discord shows them.
 * @param {import('discord.js').Guild} guild
 * @returns {Array<{ id: string, name: string }>}
 */
export function guildTextChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter((c) => TEXTY.has(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Voice / stage channels — used by the Server statistics module. */
export function guildVoiceChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Category channels — used by the Temporary voice channels module. */
export function guildCategories(guild) {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Resolve a set of user IDs to `{ id, tag }`, using the cache and falling back
 * to a REST fetch. Unknown IDs map to their raw id.
 * With `guild`, its member cache is looked at first. `maxFetch` caps the REST lookups of one call
 * (default: no cap); the ids beyond it keep their raw id.
 * @param {import('discord.js').Client} client
 * @param {Iterable<string>} ids
 * @param {{ guild?: import('discord.js').Guild, maxFetch?: number }} [options]
 * @returns {Promise<Map<string, string>>} id -> tag
 */
export async function resolveUserTags(client, ids, { guild, maxFetch = Infinity } = {}) {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map();
  let fetches = 0;
  await Promise.all(
    unique.map(async (id) => {
      const cached = guild?.members?.cache?.get(id)?.user ?? client.users.cache.get(id);
      if (cached) {
        out.set(id, cached.tag);
        return;
      }
      if (fetches >= maxFetch) {
        out.set(id, id);
        return;
      }
      fetches += 1;
      try {
        const user = await client.users.fetch(id);
        out.set(id, user.tag);
      } catch {
        out.set(id, id);
      }
    })
  );
  return out;
}
