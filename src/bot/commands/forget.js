// /forget — self-service deletion of the data Sylo stores about the caller in
// the current guild (warnings, leveling XP, ticket history).
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { forgetUser } from '../../db/purge.js';

export const data = new SlashCommandBuilder()
  .setName('forget')
  .setDescription('Delete the data Sylo has stored about you in this server.')
  .addBooleanOption((o) =>
    o.setName('confirm').setDescription('Tick to permanently delete — this cannot be undone.').setRequired(false)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: 'Run this in the server whose data you want removed.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.options.getBoolean('confirm') !== true) {
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content:
        `This permanently deletes your **warnings**, **XP / level**, **ticket history**, and **ban appeals** in ` +
        `**${interaction.guild.name}**. Moderation messages already posted to channels are not removed, ` +
        `and Sylo will still store new data going forward.\n\nRun \`/forget confirm:True\` to proceed.`,
    });
  }

  const r = forgetUser(interaction.guildId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x58d68d)
    .setTitle('Your data was deleted')
    .setDescription(`Removed in **${interaction.guild.name}**:`)
    .addFields(
      { name: 'Warnings', value: String(r.warnings), inline: true },
      { name: 'Leveling records', value: String(r.leveling), inline: true },
      { name: 'Tickets', value: `${r.tickets} (${r.ticketMessages} msgs)`, inline: true },
      { name: 'Ban appeals', value: String(r.appeals), inline: true }
    );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
