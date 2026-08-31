// /voice-transfer — hand ownership of your temporary voice channel to someone.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { transferTemp } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-transfer')
  .setDescription('Transfer ownership of your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('New owner (must be in the channel)').setRequired(true));

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx)) return interaction.reply({ content: 'Only the channel owner or a voice moderator can do that.', ...ephemeral });
  const target = interaction.options.getUser('user', true);
  if (!ctx.channel.members.has(target.id)) return interaction.reply({ content: 'That member is not in the channel.', ...ephemeral });
  if (target.id === ctx.row.owner_id) return interaction.reply({ content: 'They already own it.', ...ephemeral });
  await transferTemp(ctx.channel, interaction.guild, ctx.row, target.id);
  return interaction.reply({ content: `👑 Ownership transferred to <@${target.id}>.`, allowedMentions: { parse: [] }, ...ephemeral });
}
