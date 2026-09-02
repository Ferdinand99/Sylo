// /voice-hide — hide your temporary voice channel from everyone else.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { setHidden } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-hide')
  .setDescription('Hide your temporary voice channel from other members.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx))
    return interaction.reply({
      content: 'Only the channel owner or a voice moderator can do that.',
      ...ephemeral,
    });
  await setHidden(ctx.channel, interaction.guild, true);
  return interaction.reply({ content: '👁️ Channel hidden.', ...ephemeral });
}
