// /voice-rename — rename your temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { renameTemp } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-rename')
  .setDescription('Rename your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(100)
  );

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx))
    return interaction.reply({
      content: 'Only the channel owner or a voice moderator can do that.',
      ...ephemeral,
    });
  const name = interaction.options.getString('name', true).trim().slice(0, 100) || 'Voice channel';
  await renameTemp(ctx.channel, name);
  return interaction.reply({ content: `✏️ Renamed to **${name}**.`, ...ephemeral });
}
