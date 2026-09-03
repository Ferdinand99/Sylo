// /unban <user_id> [reason] — lift a ban.
import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { resultEmbed, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { clearTempBan } from '../../db/tempBans.js';
import { addCase, deactivateLatest } from '../../db/modCases.js';

export const data = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Remove a ban by user ID.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Reason (shown in the audit log)').setMaxLength(400)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const userId = interaction.options.getString('user_id', true).trim();
  const reason = interaction.options.getString('reason') ?? NO_REASON;
  const { guild } = interaction;

  if (!/^\d{17,20}$/.test(userId)) {
    await interaction.reply({
      content: "⚠️ That doesn't look like a valid user ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ban = await guild.bans.fetch(userId).catch(() => null);
  if (!ban) {
    await interaction.reply({ content: '⚠️ That user is not banned.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  await guild.bans.remove(userId, `${interaction.user.tag}: ${reason}`);
  clearTempBan(guild.id, userId); // in case this was a scheduled temporary ban

  const clearedCase = deactivateLatest(guild.id, userId, 'ban');
  const { caseNumber } = addCase({
    guildId: guild.id,
    userId,
    moderatorId: interaction.user.id,
    action: 'unban',
    reason,
  });
  const embed = resultEmbed({
    action: 'Ban removed',
    target: ban.user,
    moderator: interaction.user,
    reason,
    fields: [
      { name: 'Case', value: clearedCase ? `#${caseNumber} (clears #${clearedCase})` : `#${caseNumber}` },
    ],
  });
  await interaction.editReply({ embeds: [embed] });
  await postModLog(guild, embed);
}
