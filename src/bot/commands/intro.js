// /intro create|view|remove — a member's "server membership card" for the Introductions module.
//
//   /intro create         Sylo asks the questions in DM, shows a preview, and posts the card (or edits
//                         the member's existing card). Same on Fluxer: `!intro create`.
//   /intro view [user]    show a card (private on Discord)
//   /intro remove [user]  delete your own card and answers; staff with Manage Messages may name a member
//
// The questions themselves are asked by the shared DM questionnaire (bot/lib/dmQuestionnaire.js);
// the card, the settings and the rules are in modules/introductions.js.
import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { guildKey, platformOfGuild } from '../../platform/platformOf.js';
import {
  beginIntroduction,
  introRateLeft,
  removeIntroduction,
  viewIntroduction,
} from '../../modules/introductions.js';

export const data = new SlashCommandBuilder()
  .setName('intro')
  .setDescription('Make, show or remove your introduction card.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s.setName('create').setDescription('Answer a few questions in DM and post (or update) your card.')
  )
  .addSubcommand((s) =>
    s
      .setName('view')
      .setDescription("Show someone's introduction card.")
      .addUserOption((o) => o.setName('user').setDescription('Whose card (default: yours)'))
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Delete your card and your answers.')
      .addUserOption((o) =>
        o.setName('user').setDescription("Delete this member's card instead (needs Manage Messages)")
      )
  );

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function create(interaction) {
  const wait = introRateLeft(platformOfGuild(interaction.guild), interaction.user.id);
  if (wait) return eph(interaction, `Please wait ${wait} seconds before you start again.`);
  // Looking up the member and sending the first DM can take a moment.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await beginIntroduction({ guild: interaction.guild, user: interaction.user });
  return interaction.editReply({ content: result.message, allowedMentions: { parse: [] } });
}

async function view(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const card = await viewIntroduction(interaction.guild, target.id);
  if (!card) {
    return eph(
      interaction,
      target.id === interaction.user.id
        ? 'You have not made an introduction yet. Use `/intro create`.'
        : 'That member has not made an introduction.'
    );
  }
  return interaction.reply({
    embeds: card.embeds,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function remove(interaction) {
  const target = interaction.options.getUser('user');
  const own = !target || target.id === interaction.user.id;
  if (!own && !interaction.memberPermissions?.has('ManageMessages')) {
    return eph(interaction, "Only staff with Manage Messages can delete someone else's introduction.");
  }
  const removed = await removeIntroduction(interaction.guild, own ? interaction.user.id : target.id);
  if (!removed) {
    return eph(interaction, own ? 'You have no introduction to remove.' : 'That member has no introduction.');
  }
  return eph(
    interaction,
    own
      ? 'Your introduction was deleted.'
      : `The introduction of ${target.username ?? 'that member'} was deleted.`
  );
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.guild) return eph(interaction, 'Use this in a server.');
  if (!(await isModuleEnabled(guildKey(interaction.guild), 'introductions'))) {
    return eph(interaction, 'The Introductions module is off in this server.');
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') return create(interaction);
  if (sub === 'view') return view(interaction);
  return remove(interaction);
}
