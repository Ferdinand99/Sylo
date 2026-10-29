// /quote save|random|search|user|show|remove, and the "Save quote" message menu (Discord only).
// Open to every member of a server that has the Quote board module on; who may save (everyone or
// some roles) and who counts as staff are checked here against the module's settings. On Fluxer,
// which has no message menu and no slash commands: `!quote save <message link>`, or reply to the
// message with `!quote save`.
import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import {
  getQuoteByNumber,
  quoteCountOf,
  quotesByAuthor,
  randomQuote,
  searchQuotes,
} from '../../db/quotes.js';
import { guildKey } from '../../platform/platformOf.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import {
  LIMITS,
  buildQuoteEmbed,
  canRemoveQuote,
  canSaveQuotes,
  fetchQuotable,
  normaliseQuoteBoardConfig,
  normaliseQuoteQuery,
  canView,
  parseMessageLink,
  quoteFitsChannel,
  quoteLine,
  removeQuote,
  saveQuote,
} from '../../modules/quoteBoard.js';

const SEARCH_SHOWN = 5;
const USER_SHOWN = 10;

export const data = new SlashCommandBuilder()
  .setName('quote')
  .setDescription('Save and show memorable messages of this server.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('save')
      .setDescription('Save a message as a quote.')
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription('The message link (on Fluxer you can reply to the message instead)')
          .setMaxLength(300)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('random')
      .setDescription('Show a random quote.')
      .addUserOption((o) => o.setName('member').setDescription('Only quotes of this member'))
  )
  .addSubcommand((s) =>
    s
      .setName('search')
      .setDescription('Find quotes by their text or the author name.')
      .addStringOption((o) =>
        o
          .setName('text')
          .setDescription('What to look for')
          .setRequired(true)
          .setMaxLength(LIMITS.query.maxLength)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('user')
      .setDescription('List the quotes of a member.')
      .addUserOption((o) => o.setName('member').setDescription('Whose quotes').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('show')
      .setDescription('Show a quote by its number.')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('The quote number').setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a quote you wrote or saved (staff can remove any).')
      .addIntegerOption((o) =>
        o.setName('number').setDescription('The quote number').setRequired(true).setMinValue(1)
      )
  );

/** The message menu: right-click a message, Apps, Save quote. */
export const contextMenus = [
  {
    data: new ContextMenuCommandBuilder()
      .setName('Save quote')
      .setType(ApplicationCommandType.Message)
      .setContexts(InteractionContextType.Guild),
    execute: saveFromMenu,
  },
];

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

const NOT_ENABLED = 'The Quote board module is not enabled in this server.';

async function settings(interaction) {
  const mod = await getGuildModule(interaction.guildId, 'quote-board');
  return mod.enabled ? normaliseQuoteBoardConfig(mod.config) : null;
}

/**
 * Reply with the result of a save: public for a new quote, private when it was already there or
 * when it comes from a channel that this one may not show.
 */
function replySaved(interaction, result) {
  const key = guildKey(interaction.guild);
  const embed = buildQuoteEmbed(result.quote, key);
  if (!quoteFitsChannel(result.quote, interaction.channelId)) {
    return interaction.reply({
      content: `${result.existing ? 'That message is already' : 'Saved as'} quote **#${result.quote.number}**. It comes from a private channel, so only you see it here.`,
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  if (result.existing) {
    return interaction.reply({
      content: `That message is already quote **#${result.quote.number}**.`,
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  return interaction.reply({
    content: `Saved as quote **#${result.quote.number}**.`,
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function saveFromMenu(interaction) {
  const cfg = await settings(interaction);
  if (!cfg) return eph(interaction, NOT_ENABLED);
  if (!canSaveQuotes(interaction.member, interaction.memberPermissions, cfg)) {
    return eph(interaction, 'Only some roles may save quotes in this server.');
  }
  const result = await saveQuote({
    guild: interaction.guild,
    message: interaction.targetMessage,
    savedBy: interaction.user.id,
  });
  if (!result.ok) return eph(interaction, result.error);
  return replySaved(interaction, result);
}

/** Which message does `/quote save` mean: the link, or the message being replied to (Fluxer). */
function targetOf(interaction) {
  const link = interaction.options.getString('message');
  if (link) {
    const ids = parseMessageLink(link);
    if (!ids) return { error: 'That does not look like a message link. Copy it with "Copy Message Link".' };
    if (ids.guildId !== splitPlatformGuildId(interaction.guildId)?.rawId) {
      return { error: 'That message is from another server.' };
    }
    return ids;
  }
  const ref = interaction.message?.messageReference ?? interaction.message?.reference;
  if (ref?.messageId) {
    return {
      channelId: ref.channelId ?? interaction.channelId,
      messageId: ref.messageId,
    };
  }
  return { error: 'Give a message link, or reply to the message you want to save.' };
}

async function save(interaction) {
  const cfg = await settings(interaction);
  if (!cfg) return eph(interaction, NOT_ENABLED);
  if (!canSaveQuotes(interaction.member, interaction.memberPermissions, cfg)) {
    return eph(interaction, 'Only some roles may save quotes in this server.');
  }
  const target = targetOf(interaction);
  if (target.error) return eph(interaction, target.error);

  const found = await fetchQuotable({
    guild: interaction.guild,
    member: interaction.member,
    channelId: target.channelId,
    messageId: target.messageId,
  });
  if (!found.ok) return eph(interaction, found.error);
  const result = await saveQuote({
    guild: interaction.guild,
    message: found.message,
    savedBy: interaction.user.id,
  });
  if (!result.ok) return eph(interaction, result.error);
  return replySaved(interaction, result);
}

async function random(interaction) {
  const user = interaction.options.getUser('member');
  const row = await randomQuote(guildKey(interaction.guild), {
    authorId: user?.id ?? null,
    visibleIn: interaction.channelId,
  });
  if (!row) {
    return eph(
      interaction,
      user
        ? 'There are no quotes from that member to show here yet.'
        : 'There are no quotes to show here yet. Save one with /quote save.'
    );
  }
  return interaction.reply({
    embeds: [buildQuoteEmbed(row, guildKey(interaction.guild))],
    allowedMentions: { parse: [] },
  });
}

const listEmbed = (title, rows, footer) => {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(
      rows
        .map((r) => quoteLine(r))
        .join('\n')
        .slice(0, 4000)
    );
  if (footer) embed.setFooter({ text: footer });
  return embed;
};

async function search(interaction) {
  const query = normaliseQuoteQuery(interaction.options.getString('text', true));
  if (!query) return eph(interaction, 'Write what to look for.');
  const rows = await searchQuotes(guildKey(interaction.guild), query, SEARCH_SHOWN, {
    visibleIn: interaction.channelId,
  });
  if (!rows.length) return eph(interaction, 'No quote matches that.');
  return interaction.reply({
    embeds: [listEmbed(`Quotes matching "${query.slice(0, 60)}"`, rows, 'Open one with /quote show')],
    allowedMentions: { parse: [] },
  });
}

async function user(interaction) {
  const who = interaction.options.getUser('member', true);
  const key = guildKey(interaction.guild);
  const rows = await quotesByAuthor(key, who.id, USER_SHOWN, { visibleIn: interaction.channelId });
  if (!rows.length) return eph(interaction, 'There are no quotes from that member to show here yet.');
  const total = await quoteCountOf(key, who.id, { visibleIn: interaction.channelId });
  return interaction.reply({
    embeds: [
      listEmbed(
        `Quotes of ${rows[0].author_name || 'this member'}`,
        rows,
        total > rows.length ? `The latest ${rows.length} of ${total}. Open one with /quote show` : null
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

async function show(interaction) {
  const key = guildKey(interaction.guild);
  const row = await getQuoteByNumber(key, interaction.options.getInteger('number', true));
  if (!row) return eph(interaction, 'There is no quote with that number.');
  if (!quoteFitsChannel(row, interaction.channelId)) {
    // From a private channel and asked for somewhere else: only for someone who can still see that channel.
    const source =
      interaction.guild.channels?.cache?.get?.(row.channel_id) ??
      (await interaction.guild.channels?.fetch?.(row.channel_id).catch(() => null));
    if (!(await canView(source, interaction.member))) {
      return eph(interaction, 'That quote is not available here.');
    }
    return interaction.reply({
      content: 'That quote comes from a private channel, so only you see it here.',
      embeds: [buildQuoteEmbed(row, key)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  return interaction.reply({ embeds: [buildQuoteEmbed(row, key)], allowedMentions: { parse: [] } });
}

async function remove(interaction, cfg) {
  const key = guildKey(interaction.guild);
  const row = await getQuoteByNumber(key, interaction.options.getInteger('number', true));
  if (!row) return eph(interaction, 'There is no quote with that number.');
  if (!canRemoveQuote(row, interaction.user.id, interaction.member, interaction.memberPermissions, cfg)) {
    return eph(
      interaction,
      'You can only remove quotes you wrote or saved. Staff (Manage Messages or a staff role) can remove any.'
    );
  }
  await removeQuote(row);
  return eph(interaction, `Removed quote **#${row.number}**. The number will not be used again.`);
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'save') return save(interaction);
  const cfg = await settings(interaction);
  if (!cfg) return eph(interaction, NOT_ENABLED);
  if (sub === 'random') return random(interaction);
  if (sub === 'search') return search(interaction);
  if (sub === 'user') return user(interaction);
  if (sub === 'show') return show(interaction);
  return remove(interaction, cfg);
}
