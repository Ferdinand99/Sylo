// /slowmode <seconds> [channel] — set per-user rate limit on a text channel.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { formatDuration } from '../lib/duration.js';

const MAX_SECONDS = 21_600; // Discord's limit (6 hours).

export const data = new SlashCommandBuilder()
  .setName('slowmode')
  .setDescription('Set slowmode (seconds between messages) on a channel. 0 disables it.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption((o) =>
    o
      .setName('seconds')
      .setDescription('0-21600 (6h). 0 turns slowmode off.')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(MAX_SECONDS)
  )
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Target channel (defaults to here)')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread
      )
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const seconds = interaction.options.getInteger('seconds', true);
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;

  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: `⚠️ I need **Manage Channels** in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  await channel.setRateLimitPerUser(seconds, `${interaction.user.tag} via /slowmode`);

  const human = seconds === 0 ? 'disabled' : `${formatDuration(seconds * 1000)} between messages`;
  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Slowmode updated')
    .addFields(
      { name: 'Channel', value: `${channel}` },
      { name: 'Slowmode', value: human },
      { name: 'Moderator', value: interaction.user.tag }
    )
    .setTimestamp(Date.now());

  await interaction.editReply({ embeds: [embed] });
  await postModLog(interaction.guild, embed);
}
