// /inviter [user] — who invited a member.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { getJoin } from '../../db/inviteTracker.js';

export const data = new SlashCommandBuilder()
  .setName('inviter')
  .setDescription('Show who invited a member.')
  .addUserOption((o) => o.setName('user').setDescription('Whose inviter to look up').setRequired(false));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'invite-tracker')) {
    return interaction.reply({ content: 'Invite tracking is not enabled in this server.', flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  const join = getJoin(interaction.guildId, target.id);

  let msg;
  if (!join) {
    msg = `I have no record of how **${target.tag}** joined (they were here before tracking started).`;
  } else if (join.source === 'invite' && join.inviter_id) {
    msg = `**${target.tag}** was invited by <@${join.inviter_id}>.`;
  } else if (join.source === 'vanity') {
    msg = `**${target.tag}** joined through the server’s vanity URL.`;
  } else if (join.source === 'bot') {
    msg = `**${target.tag}** was added by a bot / OAuth2.`;
  } else {
    msg = `I could not determine who invited **${target.tag}**.`;
  }

  await interaction.reply({ content: msg, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
}
