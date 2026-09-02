// /poll — create a reaction poll in the current channel.
import { SlashCommandBuilder, MessageFlags, InteractionContextType } from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { createPoll } from '../../db/polls.js';
import { LETTERS, MIN_OPTIONS, parseChoices, buildPollPayload } from '../../modules/polls.js';
import { parseDuration } from '../lib/duration.js';

const MIN_MS = 60_000;
const MAX_MS = 30 * 86_400_000;

export const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Create a poll people vote on with reactions.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('question').setDescription('The poll question').setRequired(true).setMaxLength(240)
  )
  .addStringOption((o) =>
    o
      .setName('choices')
      .setDescription('Options separated by |  e.g.  Pizza | Tacos | Sushi')
      .setRequired(true)
  )
  .addStringOption((o) =>
    o.setName('duration').setDescription('Auto-close after e.g. 30m, 2h, 1d (min 1m, max 30d)')
  )
  .addBooleanOption((o) => o.setName('multiple').setDescription('Allow voting for more than one option'))
  .addIntegerOption((o) =>
    o
      .setName('max_votes')
      .setDescription('Close automatically once this many people have voted')
      .setMinValue(2)
      .setMaxValue(100000)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'polls')) {
    return interaction.reply({
      content: 'The Polls module is not enabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const question = interaction.options.getString('question', true).trim();
  const options = parseChoices(interaction.options.getString('choices', true));
  if (options.length < MIN_OPTIONS) {
    return interaction.reply({
      content: `Give at least ${MIN_OPTIONS} options, separated by \`|\` (or new lines, or commas).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let endsAt = null;
  const durationRaw = interaction.options.getString('duration');
  if (durationRaw) {
    const ms = parseDuration(durationRaw);
    if (ms == null || ms < MIN_MS || ms > MAX_MS) {
      return interaction.reply({
        content: 'Duration must be between 1m and 30d (e.g. `2h`, `1d`).',
        flags: MessageFlags.Ephemeral,
      });
    }
    endsAt = Date.now() + ms;
  }

  const poll = {
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    question,
    options,
    multiple: interaction.options.getBoolean('multiple') ?? false,
    max_votes: interaction.options.getInteger('max_votes') ?? 0,
    ends_at: endsAt,
    created_at: Date.now(),
  };
  const config = getGuildModule(interaction.guildId, 'polls').config;

  await interaction.reply(buildPollPayload(poll, config));
  const message = await interaction.fetchReply();

  createPoll({
    messageId: message.id,
    guildId: poll.guild_id,
    channelId: poll.channel_id,
    question,
    options,
    multiple: poll.multiple,
    maxVotes: poll.max_votes,
    endsAt,
    createdBy: interaction.user.id,
    createdAt: poll.created_at,
  });

  for (let i = 0; i < options.length; i += 1) {
    await message.react(LETTERS[i]).catch(() => {});
  }
}
