// /untimeout <user> [reason] — clear an active timeout.
import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { resultEmbed, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { addCase, deactivateLatest } from '../../db/modCases.js';

export const data = new SlashCommandBuilder()
  .setName('untimeout')
  .setDescription("Remove a member's timeout.")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to un-timeout').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Reason (shown in the audit log)').setMaxLength(400)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason') ?? NO_REASON;

  if (!target) {
    await interaction.reply({ content: "That user isn't in this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!target.isCommunicationDisabled()) {
    await interaction.reply({
      content: `${target.user.tag} is not timed out.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!target.moderatable) {
    await interaction.reply({
      content: "⚠️ I can't modify that member (role hierarchy).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  await target.timeout(null, `${interaction.user.tag}: ${reason}`);

  const clearedCase = deactivateLatest(interaction.guild.id, target.id, 'timeout');
  const { caseNumber } = addCase({
    guildId: interaction.guild.id,
    userId: target.id,
    moderatorId: interaction.user.id,
    action: 'untimeout',
    reason,
  });
  const embed = resultEmbed({
    action: 'Timeout removed',
    target: target.user,
    moderator: interaction.user,
    reason,
    fields: [
      { name: 'Case', value: clearedCase ? `#${caseNumber} (clears #${clearedCase})` : `#${caseNumber}` },
    ],
  });
  await interaction.editReply({ embeds: [embed] });
  await postModLog(interaction.guild, embed);
}
