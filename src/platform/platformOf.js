// Which platform a client / guild belongs to. Every guild object carries its
// client, and each platform has exactly one client in runtime.clients, so the
// answer needs no id parsing. Anything unrecognised is Discord — the platform
// every existing code path was written for.
import { runtime, clientFor } from '../runtime.js';
import { PLATFORMS, makePlatformGuildId, splitPlatformGuildId } from '../lib/platformId.js';
import { supports } from './capabilities.js';

/** @returns {'discord' | 'fluxer'} */
export function platformOfClient(client) {
  return client && runtime.clients.fluxer === client ? 'fluxer' : 'discord';
}

/** @returns {'discord' | 'fluxer'} */
export const platformOfGuild = (guild) => platformOfClient(guild?.client);

/** Does this guild's platform support `feature`? (see capabilities.js) */
export const guildSupports = (guild, feature) => supports(platformOfGuild(guild), feature);

// --- guild keys ---------------------------------------------------------------
// A guild's *key* is the id every DB row, timer, cache and dashboard URL uses: a
// Discord guild's bare id, a Fluxer guild's "fluxer:<id>" (see lib/platformId.js).
// The SDK object's own `.id` is always the raw platform id — use it only where the
// platform itself wants it (the @everyone role id, REST calls), never as a key.

const keyFor = (platform, rawId) => (platform === 'discord' ? rawId : makePlatformGuildId(platform, rawId));

/** The key for a guild object. Idempotent: an already-keyed id (an interaction's guild) is returned as is. */
export function guildKey(guild) {
  const platform = platformOfGuild(guild);
  if (platform === 'discord') return guild.id;
  return splitPlatformGuildId(guild.id)?.platform === platform
    ? guild.id
    : makePlatformGuildId(platform, guild.id);
}

/**
 * The key for the guild an entity (message, member, channel, role, ban, …) belongs
 * to, or null when it belongs to none (a DM).
 */
export function guildKeyOf(entity) {
  if (entity?.guild) return guildKey(entity.guild);
  if (entity?.guildId) return keyFor(platformOfClient(entity.client), entity.guildId);
  return null;
}

/** Every guild of every connected client — what a periodic sweep iterates. */
export function allGuilds() {
  return PLATFORMS.flatMap((p) => [...(runtime.clients[p]?.guilds.cache.values() ?? [])]);
}

/** The guild object a stored key refers to, or undefined (unknown, or its platform is not connected). */
export function guildByKey(key) {
  if (!key) return undefined;
  const parsed = splitPlatformGuildId(key);
  // Not a recognisable id (a hand-written test fixture): treat it as a Discord id.
  if (!parsed) return clientFor('discord')?.guilds.cache.get(key);
  return clientFor(parsed.platform)?.guilds.cache.get(parsed.rawId);
}

/** Is at least one connected platform client ready? Periodic sweeps wait on this. */
export function anyClientReady() {
  return PLATFORMS.some((p) => Boolean(runtime.clients[p]?.isReady?.()));
}
