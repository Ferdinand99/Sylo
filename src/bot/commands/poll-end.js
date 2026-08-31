// /poll-end — close a poll early and post its results.
import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { getPoll, latestPollInChannel } from '../../db/polls.js';
import { endPoll } from '../../modules/polls.js';

export const data = new SlashCommandBuilder()
  .setName('poll-end')
  .setDescription('Close a poll now and post the results.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('message').setDescription('Message ID or link of the poll (default: the latest poll in this channel)')
  );

const parseMessageId = (raw) => {
  const s = String(raw ?? '').trim();
  const m = s.match(/(\d{17,20})\/?$/) || s.match(/^(\d{17,20})$/);
  return m ? m[1] : null;
};

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'polls')) {
    return interaction.reply({ content: 'The Polls module is not enabled in this server.', flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.options.getString('message');
  let poll;
  if (raw) {
    const id = parseMessageId(raw);
    poll = id ? getPoll(id) : null;
    if (!poll || poll.guild_id !== interaction.guildId) {
      return interaction.reply({ content: 'No open poll found for that message.', flags: MessageFlags.Ephemeral });
    }
  } else {
    poll = latestPollInChannel(interaction.guildId, interaction.channelId);
    if (!poll) {
      return interaction.reply({ content: 'No open poll in this channel — pass a `message` id to target another one.', flags: MessageFlags.Ephemeral });
    }
  }

  const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (poll.created_by !== interaction.user.id && !canManage) {
    return interaction.reply({ content: "Only the poll's creator or a member with Manage Messages can end it.", flags: MessageFlags.Ephemeral });
  }

  await endPoll(poll.message_id);
  return interaction.reply({ content: '✅ Poll closed — results posted.', flags: MessageFlags.Ephemeral });
}
