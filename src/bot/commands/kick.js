// /kick <user> [reason] — remove a member from the server.
import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { checkActable, notifyTarget, resultEmbed, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { addCase } from '../../db/modCases.js';

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a member from the server.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
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

  const blocked = checkActable({ interaction, target, action: 'kick' });
  if (blocked) {
    await interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!target.kickable) {
    await interaction.reply({
      content: "⚠️ I can't kick that member (missing permission or role hierarchy).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const dmed = await notifyTarget(target.user, {
    guildName: interaction.guild.name,
    action: 'kicked',
    reason,
  });
  await target.kick(`${interaction.user.tag}: ${reason}`);

  const { caseNumber } = addCase({
    guildId: interaction.guild.id,
    userId: target.id,
    moderatorId: interaction.user.id,
    action: 'kick',
    reason,
  });
  const embed = resultEmbed({
    action: 'Member kicked',
    target: target.user,
    moderator: interaction.user,
    reason,
    fields: [
      { name: 'Case', value: `#${caseNumber}` },
      { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' },
    ],
  });
  await interaction.editReply({ embeds: [embed] });
  await postModLog(interaction.guild, embed);
}
