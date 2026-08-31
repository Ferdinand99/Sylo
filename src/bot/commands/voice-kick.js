// /voice-kick — disconnect someone from your temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, targetActable, ephemeral } from '../lib/tempVoiceCmd.js';

export const data = new SlashCommandBuilder()
  .setName('voice-kick')
  .setDescription('Disconnect a member from your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true));

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx)) return interaction.reply({ content: 'Only the channel owner or a voice moderator can do that.', ...ephemeral });
  const target = interaction.options.getMember('user');
  const bad = targetActable(ctx, target && ctx.channel.members.has(target.id) ? target : null);
  if (bad) return interaction.reply({ content: `⚠️ ${bad}`, ...ephemeral });
  await target.voice.disconnect(`Kicked from temp channel by ${interaction.user.tag}`).catch(() => {});
  return interaction.reply({ content: `👢 Kicked ${target}.`, allowedMentions: { parse: [] }, ...ephemeral });
}
