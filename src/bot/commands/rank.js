// /rank — show a member's leveling progress.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { getMember, memberRank, memberCount } from '../../db/leveling.js';
import { levelProgress, progressBar } from '../../modules/lib/levels.js';

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show your leveling progress (or another member’s).')
  .addUserOption((o) => o.setName('user').setDescription('Whose rank to show').setRequired(false));

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

  const user = interaction.options.getUser('user') ?? interaction.user;
  const row = getMember(interaction.guildId, user.id);
  const p = levelProgress(row.xp);
  const rank = memberRank(interaction.guildId, user.id);

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: 'Level', value: String(p.level), inline: true },
      { name: 'Rank', value: `#${rank} of ${memberCount(interaction.guildId)}`, inline: true },
      { name: 'Messages', value: String(row.messages), inline: true },
      { name: `XP · ${p.into} / ${p.need}`, value: progressBar(p.pct) }
    );

  return interaction.reply({ embeds: [embed] });
}
