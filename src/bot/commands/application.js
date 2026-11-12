// /application accept|deny <id> [reason] — staff decide on a submission with a reason. (The Accept and
// Deny buttons on the post decide at once, without one: Sylo has no modals.) Who may: Manage Server, or
// one of the form's manager roles; the check is in decideSubmission(), the same for every way to decide.
// Same on Fluxer: `!application deny 12 Not enough detail`.
import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { guildKey } from '../../platform/platformOf.js';
import { decideSubmission } from '../../modules/applications.js';

const TEXT = { accept: 'Accept an application.', deny: 'Deny an application.' };

export const data = (() => {
  const b = new SlashCommandBuilder()
    .setName('application')
    .setDescription('Staff: decide on an application.')
    .setContexts(InteractionContextType.Guild);
  for (const name of Object.keys(TEXT)) {
    b.addSubcommand((s) =>
      s
        .setName(name)
        .setDescription(TEXT[name])
        .addIntegerOption((o) =>
          o
            .setName('id')
            .setDescription('The number shown on the application post')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Why (sent to the applicant)').setMaxLength(500)
        )
    );
  }
  return b;
})();

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.guild) return eph(interaction, 'Use this in a server.');
  const key = guildKey(interaction.guild);
  if (!(await isModuleEnabled(key, 'applications'))) {
    return eph(interaction, 'The Applications module is off in this server.');
  }
  const action = interaction.options.getSubcommand();
  const id = interaction.options.getInteger('id', true);
  // A decision makes several platform calls: answer within Discord's three seconds first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await decideSubmission({
    guild: interaction.guild,
    id,
    action,
    reason: interaction.options.getString('reason') ?? '',
    by: interaction.user.id,
    actor: { member: interaction.member, permissions: interaction.memberPermissions },
  });
  const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  if (!result.ok) return reply(result.error);
  const extras = [
    result.dm ? 'applicant notified' : 'the applicant could not be messaged',
    ...result.warnings,
  ].join(' · ');
  return reply(`Application **#${id}** is now ${result.status}. ${extras}`);
}
