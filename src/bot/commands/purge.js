// /purge <amount> [user] — bulk-delete recent messages in the current channel.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';

export const data = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Delete recent messages in this channel (max 100, younger than 14 days).')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) =>
    o.setName('amount').setDescription('How many messages to scan/delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)
  )
  .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const amount = interaction.options.getInteger('amount', true);
  const user = interaction.options.getUser('user');
  const channel = interaction.channel;

  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({ content: "⚠️ I need the **Manage Messages** permission in this channel.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let messages = await channel.messages.fetch({ limit: amount });
  if (user) messages = messages.filter((m) => m.author.id === user.id);

  const deleted = await channel.bulkDelete(messages, true); // true = ignore messages older than 14 days

  await interaction.editReply(
    `🧹 Deleted **${deleted.size}** message${deleted.size === 1 ? '' : 's'}${user ? ` from ${user.tag}` : ''}.` +
      (deleted.size < messages.size ? ' (some were too old to bulk-delete)' : '')
  );

  if (deleted.size > 0) {
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Messages purged')
      .addFields(
        { name: 'Channel', value: `${channel}` },
        { name: 'Count', value: String(deleted.size) },
        { name: 'Moderator', value: interaction.user.tag },
        ...(user ? [{ name: 'Filtered to', value: user.tag }] : [])
      )
      .setTimestamp(Date.now());
    await postModLog(interaction.guild, embed);
  }
}
