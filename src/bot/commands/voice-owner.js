// /voice-owner — show who owns this temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, ephemeral } from '../lib/tempVoiceCmd.js';

export const data = new SlashCommandBuilder()
  .setName('voice-owner')
  .setDescription('Show who owns the temporary voice channel you are in.')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  const here = ctx.channel.members.has(ctx.row.owner_id);
  return interaction.reply({
    content: `👑 Owner: <@${ctx.row.owner_id}>${here ? '' : ' _(not connected — anyone here can `/voice-claim`)_'}`,
    allowedMentions: { parse: [] },
    ...ephemeral,
  });
}
