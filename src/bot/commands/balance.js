// /balance [user] — cash, bank, total and leaderboard rank.
import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { balanceOf, formatMoney } from '../../modules/economy.js';
import { economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription("Show your cash and bank balance (or another member's).")
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Whose balance to show'));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const asked = interaction.options.getUser('user');
  const user = asked ?? interaction.user;
  if (user.bot) return reply(interaction, 'Bots do not have an account.');

  const member = asked ? interaction.options.getMember?.('user') : interaction.member;
  const name = member?.displayName ?? user.globalName ?? user.username;
  const b = await balanceOf(interaction.guildId, user.id);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`Balance of ${name}`)
    .addFields(
      { name: 'Cash', value: formatMoney(b.cash, config), inline: true },
      ...(config.bankEnabled ? [{ name: 'Bank', value: formatMoney(b.bank, config), inline: true }] : []),
      { name: 'Total', value: formatMoney(b.total, config), inline: true },
      { name: 'Rank', value: b.rank ? `#${b.rank}` : 'Not ranked yet', inline: true }
    );
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
