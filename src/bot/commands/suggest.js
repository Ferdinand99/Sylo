// /suggest <text> [title] — post a suggestion for the server to vote on. Open to every member of
// a server that has the Suggestions module on. On Fluxer: `!suggest text:"Add a movie night"`.
import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import {
  LIMITS,
  createSuggestion,
  normaliseSuggestionsConfig,
  parseSuggestionInput,
} from '../../modules/suggestions.js';

export const data = new SlashCommandBuilder()
  .setName('suggest')
  .setDescription('Post a suggestion for this server to vote on.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('text').setDescription('What you suggest').setRequired(true).setMaxLength(LIMITS.text.maxLength)
  )
  .addStringOption((o) =>
    o.setName('title').setDescription('A short title (optional)').setMaxLength(LIMITS.title.maxLength)
  );

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const mod = await getGuildModule(interaction.guildId, 'suggestions');
  if (!mod.enabled) return eph(interaction, 'The Suggestions module is not enabled in this server.');
  const cfg = normaliseSuggestionsConfig(mod.config);

  const parsed = parseSuggestionInput({
    title: interaction.options.getString('title'),
    text: interaction.options.getString('text', true),
  });
  if (!parsed.ok) return eph(interaction, parsed.error);

  const channelId = cfg.channel || interaction.channelId;
  const result = await createSuggestion({
    guild: interaction.guild,
    channelId,
    authorId: interaction.user.id,
    input: parsed.value,
    cfg,
  });
  if (!result.ok) return eph(interaction, result.error);
  return eph(interaction, `Your suggestion **#${result.number}** is up in <#${channelId}>.`);
}
