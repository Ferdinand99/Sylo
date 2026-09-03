// /warn add|list|remove|clear — lightweight warning records per member.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR, INFO_COLOR, notifyTarget, resultEmbed } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { addWarning, listWarnings, getWarning, removeWarning, clearWarnings } from '../../db/modCases.js';
import { applyWarnThresholds } from '../../modules/moderation.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Issue and manage member warnings.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Warn a member.')
      .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('What they did').setRequired(true).setMaxLength(400)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription("Show a member's warnings.")
      .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Delete one warning by its ID.')
      .addIntegerOption((o) =>
        o.setName('id').setDescription('Warning ID (from /warn list)').setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('clear')
      .setDescription('Delete all warnings for a member.')
      .addUserOption((o) => o.setName('user').setDescription('Member to clear').setRequired(true))
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'add') {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);

    if (user.bot) {
      await interaction.reply({ content: "⚠️ You can't warn a bot.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    const { id, count } = addWarning({
      guildId,
      userId: user.id,
      moderatorId: interaction.user.id,
      reason,
    });
    const dmed = await notifyTarget(user, {
      guildName: interaction.guild.name,
      action: 'warned',
      reason,
      extra: `This is warning #${count}.`,
    });

    const embed = resultEmbed({
      action: 'Member warned',
      target: user,
      moderator: interaction.user,
      reason,
      fields: [
        { name: 'Warning ID', value: `#${id}` },
        { name: 'Total warnings', value: String(count) },
        { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' },
      ],
    });
    await interaction.editReply({ embeds: [embed] });
    await postModLog(interaction.guild, embed);
    await applyWarnThresholds(interaction.guild, user, count, interaction.user.tag);
    return;
  }

  if (sub === 'list') {
    const user = interaction.options.getUser('user', true);
    const rows = listWarnings(guildId, user.id);

    const embed = new EmbedBuilder()
      .setColor(INFO_COLOR)
      .setTitle(`Warnings for ${user.tag}`)
      .setThumbnail(user.displayAvatarURL());

    if (rows.length === 0) {
      embed.setDescription('No warnings on record.');
    } else {
      embed.setDescription(`${rows.length} warning${rows.length === 1 ? '' : 's'} on record.`);
      for (const w of rows.slice(0, 25)) {
        const by = /^\d+$/.test(w.moderator_id) ? `<@${w.moderator_id}>` : 'Dashboard';
        embed.addFields({
          name: `#${w.id} · <t:${Math.floor(w.created_at / 1000)}:d>`,
          value: `By ${by} — ${w.reason}`,
        });
      }
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    const existing = getWarning(guildId, id);
    if (!existing || !removeWarning(guildId, id)) {
      await interaction.reply({
        content: `⚠️ No warning #${id} in this server.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const target = await interaction.client.users.fetch(existing.user_id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Warning removed')
      .addFields(
        { name: 'Warning ID', value: `#${id}` },
        {
          name: 'User',
          value: target ? `${target.tag} (\`${existing.user_id}\`)` : `\`${existing.user_id}\``,
        },
        { name: 'Original reason', value: existing.reason },
        { name: 'Removed by', value: interaction.user.tag }
      )
      .setTimestamp(Date.now());
    await interaction.editReply({ embeds: [embed] });
    await postModLog(interaction.guild, embed);
    return;
  }

  if (sub === 'clear') {
    const user = interaction.options.getUser('user', true);
    const n = clearWarnings(guildId, user.id);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Warnings cleared')
      .addFields(
        { name: 'User', value: `${user.tag} (\`${user.id}\`)` },
        { name: 'Removed', value: `${n} warning${n === 1 ? '' : 's'}` },
        { name: 'Moderator', value: interaction.user.tag }
      )
      .setTimestamp(Date.now());
    await interaction.reply({ embeds: [embed] });
    if (n > 0) await postModLog(interaction.guild, embed);
    return;
  }
}
