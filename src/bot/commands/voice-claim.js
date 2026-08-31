// /voice-claim — take ownership when the current owner has left.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, ephemeral } from '../lib/tempVoiceCmd.js';
import { transferTemp } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-claim')
  .setDescription('Claim ownership of a temporary voice channel whose owner has left.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (ctx.isOwner) return interaction.reply({ content: 'You already own this channel.', ...ephemeral });
  if (ctx.channel.members.has(ctx.row.owner_id) && !ctx.isModerator) {
    return interaction.reply({ content: "The owner is still here — you can't claim it.", ...ephemeral });
  }
  await transferTemp(ctx.channel, interaction.guild, ctx.row, interaction.user.id);
  return interaction.reply({ content: '👑 You now own this channel.', ...ephemeral });
}
