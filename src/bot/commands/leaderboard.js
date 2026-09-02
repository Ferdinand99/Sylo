// /leaderboard — top members by leveling XP as an image card (falls back to a
// text embed), plus a link to the web leaderboard.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from '../../config.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { topMembers, memberRank } from '../../db/leveling.js';
import { renderLeaderboardCard } from '../lib/rankCard.js';
import { log } from '../../lib/log.js';

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

  await interaction.deferReply();

  // One bulk fetch for all rows; members who left the guild just won't be in it.
  const ids = rows.map((r) => r.user_id);
  const members = await interaction.guild.members.fetch({ user: ids }).catch(() => new Map());
  const missing = ids.filter((id) => !members.has(id));
  const users = new Map(
    (await Promise.all(missing.map((id) => interaction.client.users.fetch(id).catch(() => null))))
      .filter(Boolean)
      .map((u) => [u.id, u])
  );

  const entries = rows.map((r, i) => {
    const who = members.get(r.user_id) ?? users.get(r.user_id) ?? null;
    return {
      rank: i + 1,
      name: who?.displayName || who?.username || r.user_id,
      avatarUrl: who?.displayAvatarURL?.({ extension: 'png', size: 64, forceStatic: true }) || '',
      level: r.level,
      xp: r.xp,
    };
  });

  const yourRank = memberRank(interaction.guildId, interaction.user.id);
  const cfg = getGuildModule(interaction.guildId, 'leveling').config;
  const components =
    config.dashboardUrl && cfg.publicLeaderboard !== false
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel('Full leaderboard')
              .setURL(`${config.dashboardUrl}/leaderboard/${interaction.guildId}`)
          ),
        ]
      : undefined;

  try {
    const png = await renderLeaderboardCard({
      title: `Leaderboard — ${interaction.guild.name}`,
      iconUrl: interaction.guild.iconURL({ extension: 'png', size: 128 }) || null,
      rows: entries,
      footer: `Your rank: #${yourRank}`,
    });
    if (png) {
      return interaction.editReply({
        files: [new AttachmentBuilder(png, { name: 'leaderboard.png' })],
        components,
      });
    }
  } catch (err) {
    log.warn('leaderboard-card', 'render failed — falling back to embed', err.message);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setTitle(`Leaderboard — ${interaction.guild.name}`)
    .setDescription(
      entries
        .map((e) => `${MEDALS[e.rank - 1] ?? `\`#${e.rank}\``} **${e.name}** — level ${e.level} · ${e.xp} XP`)
        .join('\n')
    )
    .setFooter({ text: `Your rank: #${yourRank}` });

  return interaction.editReply({ embeds: [embed], components });
}
