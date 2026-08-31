// /voice-limit — set the user limit of your temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';

export const data = new SlashCommandBuilder()
  .setName('voice-limit')
  .setDescription('Set the user limit of your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addIntegerOption((o) => o.setName('limit').setDescription('0 = unlimited').setRequired(true).setMinValue(0).setMaxValue(99));

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx)) return interaction.reply({ content: 'Only the channel owner or a voice moderator can do that.', ...ephemeral });
  const limit = interaction.options.getInteger('limit', true);
  await ctx.channel.setUserLimit(limit).catch(() => {});
  return interaction.reply({ content: limit ? `👥 User limit set to ${limit}.` : '👥 User limit removed.', ...ephemeral });
}
