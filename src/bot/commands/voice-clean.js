// /voice-clean — delete every empty temporary voice channel in the server.
import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { listGuildTempChannels, removeTempChannel } from '../../db/tempVoice.js';
import { hubForChannel } from '../../modules/tempVoice.js';
import { ephemeral } from '../lib/tempVoiceCmd.js';

export const data = new SlashCommandBuilder()
  .setName('voice-clean')
  .setDescription('Delete all empty temporary voice channels in this server.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'temp-voice')) {
    return interaction.reply({ content: 'Temporary voice channels are not enabled here.', ...ephemeral });
  }
  const rows = listGuildTempChannels(interaction.guildId);
  const roleIds = [...(interaction.member.roles?.cache?.keys() ?? [])];
  const isMod =
    interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels) ||
    rows.some((r) => (hubForChannel(interaction.guildId, r.hub_id)?.moderatorRoles ?? []).some((x) => roleIds.includes(x)));
  if (!isMod) return interaction.reply({ content: 'You need Manage Channels or a voice-moderator role.', ...ephemeral });

  await interaction.deferReply(ephemeral);
  let n = 0;
  for (const r of rows) {
    const ch = interaction.guild.channels.cache.get(r.channel_id);
    if (!ch) {
      if (r.text_channel_id) await interaction.guild.channels.delete(r.text_channel_id).catch(() => {});
      removeTempChannel(r.channel_id);
      continue;
    }
    if (ch.members.size === 0) {
      await ch.delete('voice-clean').catch(() => {});
      if (r.text_channel_id) await interaction.guild.channels.delete(r.text_channel_id).catch(() => {});
      removeTempChannel(r.channel_id);
      n += 1;
    }
  }
  return interaction.editReply({ content: `🧹 Cleaned ${n} empty channel${n === 1 ? '' : 's'}.` });
}
