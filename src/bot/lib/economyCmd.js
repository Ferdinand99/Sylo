// Shared by the Economy commands (balance, daily, work, deposit, withdraw, pay, rob,
// economy-leaderboard, eco): the guild-and-module gate and the reply helpers. The rules are in
// modules/economy.js; this file only talks to the member.
import { MessageFlags } from 'discord.js';
import { economySettings } from '../../modules/economy.js';

/** A reply only the member sees (public and short-lived on Fluxer). Never pings anyone. */
export const reply = (interaction, content, extra = {}) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...extra });

/** A reply for the whole channel. Pings only the ids in `users`. */
export const announce = (interaction, content, users = []) =>
  interaction.reply({ content, allowedMentions: { parse: [], users } });

/**
 * Check that the command runs in a server with the Economy module on. Replies and returns null
 * when it does not; otherwise returns the normalised settings.
 */
export async function economyGate(interaction) {
  if (!interaction.inGuild()) {
    await reply(interaction, 'Use this in a server.');
    return null;
  }
  const { enabled, config } = await economySettings(interaction.guildId);
  if (!enabled) {
    await reply(interaction, 'The Economy module is off in this server.');
    return null;
  }
  return config;
}

/** The description of an amount option that takes a number or the word "all". */
export const AMOUNT_HELP = 'A whole number, or "all"';
