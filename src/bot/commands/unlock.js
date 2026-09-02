// /unlock [channel] [reason] — undo /lock, restoring the prior @everyone
// overwrite exactly.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { lockPreflight, unlockChannel } from '../lib/channelLock.js';
import { isChannelLocked } from '../../db/channelLocks.js';

const LOCKABLE = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
];

export const data = new SlashCommandBuilder()
  .setName('unlock')
  .setDescription('Let @everyone send messages in a channel again.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Channel to unlock (defaults to here)')
      .addChannelTypes(...LOCKABLE)
  )
  .addStringOption((o) =>
    o.setName('reason').setDescription('Shown in the audit log and mod-log').setMaxLength(400)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const reason = interaction.options.getString('reason') ?? NO_REASON;

  const err = lockPreflight(channel);
  if (err) {
    await interaction.reply({ content: `⚠️ ${err}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isChannelLocked(interaction.guildId, channel.id)) {
    await interaction.reply({ content: `⚠️ ${channel} isn't locked.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  await unlockChannel(channel, { moderatorTag: interaction.user.tag });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Channel unlocked')
    .addFields(
      { name: 'Channel', value: `${channel}` },
      { name: 'Moderator', value: interaction.user.tag },
      { name: 'Reason', value: reason }
    )
    .setTimestamp(Date.now());

  await interaction.editReply({ embeds: [embed] });
  if (channel.id !== interaction.channelId && channel.isTextBased?.()) {
    await channel.send({ content: '🔓 This channel has been unlocked.' }).catch(() => {});
  }
  await postModLog(interaction.guild, embed);
}
