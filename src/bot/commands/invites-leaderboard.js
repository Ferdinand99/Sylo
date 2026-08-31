// /invites-leaderboard — top inviters in this server.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { topInviters } from '../../db/inviteTracker.js';

export const data = new SlashCommandBuilder()
  .setName('invites-leaderboard')
  .setDescription('Show the top inviters in this server.');

const MEDALS = ['🥇', '🥈', '🥉'];

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'invite-tracker')) {
    return interaction.reply({ content: 'Invite tracking is not enabled in this server.', flags: MessageFlags.Ephemeral });
  }

  const rows = topInviters(interaction.guildId, 15);
  if (!rows.length) {
    return interaction.reply({ content: 'No invites tracked yet.', flags: MessageFlags.Ephemeral });
  }

  const lines = rows.map((r, i) => {
    const badge = MEDALS[i] ?? `**${i + 1}.**`;
    return `${badge} <@${r.user_id}> — **${r.net}** invite${r.net === 1 ? '' : 's'}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setTitle(`Invite leaderboard — ${interaction.guild.name}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Net = people who joined and stayed, plus any bonus' });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
