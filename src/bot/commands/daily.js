// /daily — the daily reward, bigger for each day in a row (up to a week).
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { DAILY_STREAK_CAP, claimDaily, formatMoney, refusalText } from '../../modules/economy.js';
import { economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Claim your daily reward. Come back every day for a bigger one.')
  .setContexts(InteractionContextType.Guild);

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const out = await claimDaily({ guildId: interaction.guildId, userId: interaction.user.id, config });
  if (!out.ok) return reply(interaction, refusalText(out, config));
  const streak =
    out.streak > 1
      ? ` Streak: ${out.streak} days${out.streak >= DAILY_STREAK_CAP ? ' (the most it counts)' : ''}, with ${formatMoney(out.bonus, config)} extra.`
      : ' Come back tomorrow to start a streak.';
  return reply(
    interaction,
    `You claimed ${formatMoney(out.amount, config)}.${streak} You now have ${formatMoney(out.account.cash, config)} in cash.`
  );
}
