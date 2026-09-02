// /voice-reveal — make a hidden temporary voice channel visible again.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { setHidden } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-reveal')
  .setDescription('Reveal your hidden temporary voice channel.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx))
    return interaction.reply({
      content: 'Only the channel owner or a voice moderator can do that.',
      ...ephemeral,
    });
  await setHidden(ctx.channel, interaction.guild, false);
  return interaction.reply({ content: '👁️ Channel revealed.', ...ephemeral });
}
