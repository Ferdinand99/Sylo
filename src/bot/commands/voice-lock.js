// /voice-lock — stop new people from joining your temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { setLock } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-lock')
  .setDescription('Lock your temporary voice channel so no one else can join.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx))
    return interaction.reply({
      content: 'Only the channel owner or a voice moderator can do that.',
      ...ephemeral,
    });
  await setLock(ctx.channel, interaction.guild, true);
  return interaction.reply({ content: '🔒 Channel locked.', ...ephemeral });
}
