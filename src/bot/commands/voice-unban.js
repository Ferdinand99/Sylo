// /voice-unban — lift a temporary-channel ban.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, ephemeral } from '../lib/tempVoiceCmd.js';
import { unbanFromChannel } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-unban')
  .setDescription('Unban a member from your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Member to unban').setRequired(true));

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx))
    return interaction.reply({
      content: 'Only the channel owner or a voice moderator can do that.',
      ...ephemeral,
    });
  const user = interaction.options.getUser('user', true);
  if (!ctx.row.banList.includes(user.id))
    return interaction.reply({ content: 'That member is not banned here.', ...ephemeral });
  await unbanFromChannel(ctx.channel, ctx.row, user.id);
  return interaction.reply({
    content: `✅ Unbanned <@${user.id}>.`,
    allowedMentions: { parse: [] },
    ...ephemeral,
  });
}
