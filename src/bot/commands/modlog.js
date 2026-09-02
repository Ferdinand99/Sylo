// /modlog set|disable|status — choose where moderation actions are logged.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { getGuildSettings, setModlogChannel } from '../../db/guildSettings.js';

export const data = new SlashCommandBuilder()
  .setName('modlog')
  .setDescription('Configure the moderation log channel.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Send moderation actions to a channel.')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel for the log')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  )
  .addSubcommand((s) => s.setName('disable').setDescription('Stop logging moderation actions.'))
  .addSubcommand((s) => s.setName('status').setDescription('Show the current mod-log channel.'));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      await interaction.reply({
        content: `⚠️ I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setModlogChannel(guildId, channel.id);
    await interaction.reply({
      content: `✅ Moderation actions will be logged in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === 'disable') {
    setModlogChannel(guildId, null);
    await interaction.reply({ content: '✅ Moderation logging disabled.', flags: MessageFlags.Ephemeral });
    return;
  }

  // status
  const current = getGuildSettings(guildId)?.modlog_channel_id;
  await interaction.reply({
    content: current ? `Mod-log channel: <#${current}>` : 'Mod-log is not configured. Use `/modlog set`.',
    flags: MessageFlags.Ephemeral,
  });
}
