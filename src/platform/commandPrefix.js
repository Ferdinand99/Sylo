// How a command is written for a guild: `/name` on Discord, `<prefix>name` on Fluxer, where the
// prefix is the one the server set in the dashboard, else the instance default (COMMAND_PREFIX).
import { config } from '../config.js';
import { getCommandPrefix } from '../db/guildSettings.js';
import { guildKey, platformOfClient, platformOfGuild } from './platformOf.js';

/**
 * The prefix a Fluxer server's commands use: its own, else the instance default.
 * Reads the per-guild cache, so it costs no query per message.
 * @param {string | null | undefined} key  the guild key, or null for a DM (always the default)
 * @param {string} [fallback]  the instance default
 * @returns {Promise<string>}
 */
export async function effectiveCommandPrefix(key, fallback = config.commandPrefix) {
  return (key && (await getCommandPrefix(key))) || fallback;
}

/**
 * The prefix to show a guild's members: `/` on Discord, the Fluxer server's prefix elsewhere.
 * @param {any} guild
 * @returns {Promise<string>}
 */
export async function guildCommandPrefix(guild) {
  if (platformOfGuild(guild) === 'discord') return '/';
  return effectiveCommandPrefix(guildKey(guild));
}

/**
 * The prefix for a command being run: `/` for a slash command, else the prefix of the server it
 * was typed in (the instance default in a DM). Works for a MessageInteraction and a real one.
 * @param {{ client?: any, guild?: any }} interaction
 * @returns {Promise<string>}
 */
export async function interactionCommandPrefix(interaction) {
  if (platformOfClient(interaction.client) === 'discord') return '/';
  return effectiveCommandPrefix(interaction.guild ? guildKey(interaction.guild) : null);
}
