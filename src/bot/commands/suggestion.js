// /suggestion approve|deny|implement|consider <id> [reason] — staff decisions on a suggestion.
// Staff = Manage Server, Administrator or one of the staff roles set on the Suggestions page. The
// code checks that itself, so the command is visible to everyone and works the same on Fluxer
// (`!suggestion approve id:12 reason:"Starting next week"`).
import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import { getSuggestionByNumber } from '../../db/suggestions.js';
import {
  ACTIONS,
  LIMITS,
  STATUS_META,
  canManageSuggestions,
  decide,
  normaliseSuggestionsConfig,
} from '../../modules/suggestions.js';

const SUB_TEXT = {
  approve: 'Approve a suggestion.',
  deny: 'Deny a suggestion.',
  implement: 'Mark a suggestion as implemented.',
  consider: 'Mark a suggestion as being considered.',
};

export const data = (() => {
  const b = new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Staff: decide on a suggestion.')
    .setContexts(InteractionContextType.Guild);
  for (const name of Object.keys(ACTIONS)) {
    b.addSubcommand((s) =>
      s
        .setName(name)
        .setDescription(SUB_TEXT[name])
        .addIntegerOption((o) =>
          o
            .setName('id')
            .setDescription('The number shown on the suggestion, e.g. 12')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o
            .setName('reason')
            .setDescription('Why (shown on the suggestion and sent to the author)')
            .setMaxLength(LIMITS.reason.maxLength)
        )
    );
  }
  return b;
})();

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const mod = await getGuildModule(interaction.guildId, 'suggestions');
  if (!mod.enabled) return eph(interaction, 'The Suggestions module is not enabled in this server.');
  const cfg = normaliseSuggestionsConfig(mod.config);
  if (!canManageSuggestions(interaction.member, interaction.memberPermissions, cfg)) {
    return eph(
      interaction,
      'Only staff can decide on suggestions: you need the Manage Server permission or one of the staff roles set on the Suggestions page.'
    );
  }

  const action = interaction.options.getSubcommand();
  const number = interaction.options.getInteger('id', true);
  const row = await getSuggestionByNumber(interaction.guildId, number);
  if (!row) return eph(interaction, `There is no suggestion #${number} in this server.`);

  const result = await decide(row, action, {
    reason: interaction.options.getString('reason') ?? '',
    by: interaction.user.id,
  });
  if (!result.ok) return eph(interaction, result.error);
  const label = STATUS_META[result.status].label.toLowerCase();
  const extras = [result.moved ? 'moved to the log channel' : null, result.dm ? 'author notified' : null]
    .filter(Boolean)
    .join(', ');
  return eph(interaction, `Suggestion **#${number}** is now ${label}${extras ? ` (${extras})` : ''}.`);
}
