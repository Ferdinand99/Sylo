// /pay <user> <amount> — send cash to another member. The server can charge a tax on top.
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { MAX_BALANCE, doPay, formatMoney, refusalText } from '../../modules/economy.js';
import { announce, economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('pay')
  .setDescription('Send some of your cash to another member.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Who gets the money').setRequired(true))
  .addIntegerOption((o) =>
    o.setName('amount').setDescription('How much').setRequired(true).setMinValue(1).setMaxValue(MAX_BALANCE)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const target = interaction.options.getUser('user', true);
  // Only a member of this server can be paid: money sent to someone who left would be lost.
  if (target.id !== interaction.user.id && !target.bot) {
    const member =
      interaction.options.getMember?.('user') ??
      (await interaction.guild.members.fetch(target.id).catch(() => null));
    if (!member) return reply(interaction, 'That member is not in this server.');
  }
  const out = await doPay({
    guildId: interaction.guildId,
    fromId: interaction.user.id,
    toId: target.id,
    toIsBot: target.bot === true,
    amount: interaction.options.getInteger('amount', true),
    config,
  });
  if (!out.ok) return reply(interaction, refusalText(out, config));
  const tax = out.tax > 0 ? ` (and ${formatMoney(out.tax, config)} tax)` : '';
  return announce(
    interaction,
    `<@${interaction.user.id}> paid <@${target.id}> ${formatMoney(out.amount, config)}${tax}.`,
    [target.id]
  );
}
