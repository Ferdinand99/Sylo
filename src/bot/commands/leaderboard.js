// /leaderboard — top members by leveling XP, with a link to the web leaderboard.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from '../../config.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { topMembers, memberRank } from '../../db/leveling.js';
import { resolveUserTags } from '../../web/lib/discord.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show the top members by XP in this server.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'leveling')) {
    return interaction.reply({
      content: 'Leveling is not enabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rows = topMembers(interaction.guildId, 10);
  if (rows.length === 0) {
    return interaction.reply({ content: 'No one has earned any XP yet.', flags: MessageFlags.Ephemeral });
  }

  const tags = await resolveUserTags(interaction.client, rows.map((r) => r.user_id));
  const lines = rows.map((r, i) => {
    const rankMark = MEDALS[i] ?? `\`#${i + 1}\``;
    return `${rankMark} **${tags.get(r.user_id) ?? r.user_id}** — level ${r.level} · ${r.xp} XP`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setTitle(`Leaderboard — ${interaction.guild.name}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Your rank: #${memberRank(interaction.guildId, interaction.user.id)}` });

  const reply = { embeds: [embed] };

  // Link to the public web leaderboard when the dashboard has a public URL and
  // the guild hasn't turned its leaderboard off.
  const cfg = getGuildModule(interaction.guildId, 'leveling').config;
  if (config.dashboardUrl && cfg.publicLeaderboard !== false) {
    reply.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Full leaderboard')
          .setURL(`${config.dashboardUrl}/leaderboard/${interaction.guildId}`)
      ),
    ];
  }

  return interaction.reply(reply);
}
