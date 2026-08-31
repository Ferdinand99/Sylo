// /voice-ban — block a member from re-joining your temporary voice channel.
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { resolveContext, canControl, targetActable, ephemeral } from '../lib/tempVoiceCmd.js';
import { banFromChannel } from '../../modules/tempVoice.js';

export const data = new SlashCommandBuilder()
  .setName('voice-ban')
  .setDescription('Ban a member from your temporary voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Member to ban').setRequired(true));

export async function execute(interaction) {
  const ctx = resolveContext(interaction);
  if (ctx.error) return interaction.reply({ content: ctx.error, ...ephemeral });
  if (!canControl(ctx)) {
    return interaction.reply({ content: 'Only the channel owner or a voice moderator can do that.', ...ephemeral });
  }

  const user = interaction.options.getUser('user', true);
  const targetMember = interaction.options.getMember('user');
  // targetActable wants a member; synthesise a minimal one when they're not in the guild.
  const bad = targetActable(ctx, targetMember ?? { id: user.id, roles: { cache: new Map() } });
  if (bad) return interaction.reply({ content: `⚠️ ${bad}`, ...ephemeral });
  if (ctx.row.banList.includes(user.id)) {
    return interaction.reply({ content: 'That member is already banned here.', ...ephemeral });
  }

  await banFromChannel(ctx.channel, ctx.row, user.id);
  return interaction.reply({
    content: `🔨 Banned <@${user.id}> from this channel.`,
    allowedMentions: { parse: [] },
    ...ephemeral,
  });
}
