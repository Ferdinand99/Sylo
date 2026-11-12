// /work — earn some money, once per cooldown.
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { doWork, formatMoney, refusalText } from '../../modules/economy.js';
import { economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('work')
  .setDescription('Do a job and earn some money.')
  .setContexts(InteractionContextType.Guild);

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const out = await doWork({ guildId: interaction.guildId, userId: interaction.user.id, config });
  if (!out.ok) return reply(interaction, refusalText(out, config));
  return reply(interaction, out.line.replace('{amount}', formatMoney(out.amount, config)));
}
