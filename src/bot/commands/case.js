// /case view|reason|delete|note — inspect and manage moderation case-log rows.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR, INFO_COLOR } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { getCase, editCaseReason, setCaseActive, addCase } from '../../db/modCases.js';
import { ACTION_LABELS, moderatorMention } from './history.js';

export const data = new SlashCommandBuilder()
  .setName('case')
  .setDescription('Inspect or manage a moderation case.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((s) =>
    s
      .setName('view')
      .setDescription('Show one case in full.')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('reason')
      .setDescription("Change a case's reason.")
      .addIntegerOption((o) =>
        o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)
      )
      .addStringOption((o) =>
        o.setName('text').setDescription('New reason').setRequired(true).setMaxLength(1000)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('delete')
      .setDescription('Soft-delete a case (kept for audit, hidden from /history and the warn count).')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('note')
      .setDescription('Add a private note to a member (no DM, no punishment).')
      .addUserOption((o) => o.setName('user').setDescription('Member the note is about').setRequired(true))
      .addStringOption((o) =>
        o.setName('text').setDescription('The note').setRequired(true).setMaxLength(1000)
      )
  );

function caseEmbed(c, title = `Case #${c.case_number}`) {
  return new EmbedBuilder()
    .setColor(c.active ? MOD_COLOR : INFO_COLOR)
    .setTitle(`${title}${c.active ? '' : ' · deleted'}`)
    .addFields(
      { name: 'Type', value: ACTION_LABELS[c.action] ?? c.action, inline: true },
      { name: 'User', value: `<@${c.user_id}> (\`${c.user_id}\`)`, inline: true },
      { name: 'Moderator', value: moderatorMention(c.moderator_id), inline: true },
      { name: 'Reason', value: c.reason || '_no reason given_' },
      ...(c.detail ? [{ name: 'Detail', value: c.detail, inline: true }] : []),
      { name: 'When', value: `<t:${Math.floor(c.created_at / 1000)}:F>`, inline: true }
    )
    .setTimestamp(c.created_at);
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'note') {
    const user = interaction.options.getUser('user', true);
    const text = interaction.options.getString('text', true);
    const { caseNumber } = addCase({
      guildId,
      userId: user.id,
      moderatorId: interaction.user.id,
      action: 'note',
      reason: text,
    });
    const embed = new EmbedBuilder()
      .setColor(INFO_COLOR)
      .setTitle(`Note added · Case #${caseNumber}`)
      .addFields(
        { name: 'User', value: `${user.tag} (\`${user.id}\`)` },
        { name: 'Moderator', value: interaction.user.tag },
        { name: 'Note', value: text }
      )
      .setTimestamp(Date.now());
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    await postModLog(interaction.guild, embed);
    return;
  }

  const number = interaction.options.getInteger('number', true);
  const existing = getCase(guildId, number);
  if (!existing) {
    await interaction.reply({
      content: `⚠️ No case #${number} in this server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === 'view') {
    await interaction.reply({ embeds: [caseEmbed(existing)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'reason') {
    const text = interaction.options.getString('text', true);
    editCaseReason(guildId, number, text);
    const updated = getCase(guildId, number);
    const embed = caseEmbed(updated, `Case #${number} reason updated`)
      .setColor(MOD_COLOR)
      .addFields({ name: 'Edited by', value: interaction.user.tag });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    await postModLog(interaction.guild, embed);
    return;
  }

  // sub === 'delete'
  if (!existing.active) {
    await interaction.reply({
      content: `Case #${number} is already deleted.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  setCaseActive(guildId, number, false);
  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle(`Case #${number} deleted`)
    .addFields(
      { name: 'Type', value: ACTION_LABELS[existing.action] ?? existing.action, inline: true },
      { name: 'User', value: `<@${existing.user_id}>`, inline: true },
      { name: 'Original reason', value: existing.reason || '_none_' },
      { name: 'Deleted by', value: interaction.user.tag }
    )
    .setTimestamp(Date.now());
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  await postModLog(interaction.guild, embed);
}
