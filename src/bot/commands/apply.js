// /apply start [form] | /apply withdraw [form] — apply for a form of the Applications module, or take a
// pending application back. Discord cannot run a command that has an option and subcommands at once,
// so the two are subcommands; with one open form, `/apply start` needs no name. Same on Fluxer:
// `!apply start Staff` and `!apply withdraw`.
//
// What happens next depends on the form: a DM questionnaire, a link to the web form, or a choice of
// both (modules/applications.js, beginApplication).
import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { guildKey, platformOfGuild } from '../../platform/platformOf.js';
import { pendingOfUser } from '../../db/applications.js';
import {
  beginApplication,
  keepReplyFor,
  loadForms,
  pickForm,
  startRateLeft,
  withdrawSubmission,
} from '../../modules/applications.js';

export const data = new SlashCommandBuilder()
  .setName('apply')
  .setDescription('Apply for a form of this server, or take your application back.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Start an application.')
      .addStringOption((o) =>
        o
          .setName('form')
          .setDescription('Which form (not needed when there is only one)')
          .setAutocomplete(true)
          .setMaxLength(100)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('withdraw')
      .setDescription('Withdraw your pending application.')
      .addStringOption((o) =>
        o
          .setName('form')
          .setDescription('Which form (not needed when you have only one pending)')
          .setAutocomplete(true)
          .setMaxLength(100)
      )
  );

/**
 * Discord's suggestions while typing: for start, the open forms whose name contains the text; for withdraw,
 * the forms the member has a pending application for (whatever state the form is in now).
 */
export async function autocomplete(interaction) {
  const key = interaction.guildId;
  if (!key) return interaction.respond([]);
  const text = String(interaction.options.getFocused() ?? '').toLowerCase();
  if (interaction.options.getSubcommand?.() === 'withdraw') {
    const mine = (await pendingOfUser(key, interaction.user.id)).filter(
      (s) => !text || s.formName.toLowerCase().includes(text)
    );
    return interaction.respond(
      mine.slice(0, 25).map((s) => ({ name: s.formName.slice(0, 100), value: String(s.formId) }))
    );
  }
  if (!(await isModuleEnabled(key, 'applications'))) return interaction.respond([]);
  const forms = (await loadForms(key)).filter(
    (f) => f.enabled && (!text || f.name.toLowerCase().includes(text))
  );
  return interaction.respond(
    forms.slice(0, 25).map((f) => ({ name: f.name.slice(0, 100), value: String(f.id) }))
  );
}

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function start(interaction, forms) {
  const picked = pickForm(forms, interaction.options.getString('form'));
  if (picked.ambiguous) {
    return picked.ambiguous.length === 0
      ? eph(interaction, 'There is no open form right now.')
      : eph(
          interaction,
          `Which form? ${picked.ambiguous.map((f) => `**${f.name}**`).join(', ')}. Use \`/apply start form:<name>\`.`
        );
  }
  if (!picked.form) return eph(interaction, 'There is no open form with that name.');
  const wait = startRateLeft(platformOfGuild(interaction.guild), interaction.user.id);
  if (wait) return eph(interaction, `Please wait ${wait} seconds before you start again.`);
  // Looking up the member and sending the first DM can take longer than Discord waits for a reply.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await beginApplication({
    guild: interaction.guild,
    user: interaction.user,
    form: picked.form,
  });
  keepReplyFor(interaction, result.holdMs);
  return interaction.editReply({
    content: result.content,
    ...(result.components && { components: result.components }),
    allowedMentions: { parse: [] },
  });
}

// A member can always take back their own pending application, by the name of its form: whatever the
// form's state is now, and also with the module off.
async function withdraw(interaction) {
  const result = await withdrawSubmission({
    guild: interaction.guild,
    userId: interaction.user.id,
    formText: interaction.options.getString('form'),
  });
  return eph(interaction, result.ok ? `Your application #${result.id} was withdrawn.` : result.error);
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.guild) return eph(interaction, 'Use this in a server.');
  if (interaction.options.getSubcommand() === 'withdraw') return withdraw(interaction);
  const key = guildKey(interaction.guild);
  if (!(await isModuleEnabled(key, 'applications'))) {
    return eph(interaction, 'The Applications module is off in this server.');
  }
  return start(interaction, await loadForms(key));
}
