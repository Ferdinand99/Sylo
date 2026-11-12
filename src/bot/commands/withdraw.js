// /withdraw <amount|all> — take money out of the bank.
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { doWithdraw, formatMoney, refusalText } from '../../modules/economy.js';
import { parseAmount } from '../../modules/lib/economyConfig.js';
import { AMOUNT_HELP, economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('withdraw')
  .setDescription('Take money out of the bank.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('amount').setDescription(AMOUNT_HELP).setRequired(true).setMaxLength(20));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const amount = parseAmount(interaction.options.getString('amount', true));
  if (amount === null) return reply(interaction, refusalText({ reason: 'invalid_amount' }, config));
  const out = await doWithdraw({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    amount: typeof amount === 'object' ? 'all' : amount,
    config,
  });
  if (!out.ok) return reply(interaction, refusalText(out, config));
  return reply(
    interaction,
    `You withdrew ${formatMoney(out.moved, config)}. Cash ${formatMoney(out.account.cash, config)} · bank ${formatMoney(out.account.bank, config)}.`
  );
}
