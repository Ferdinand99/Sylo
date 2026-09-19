// /help — overview of Sylo's commands and where to configure it. Paginated
// by category via a select menu rather than one giant embed, both so it
// reads better and so no single field can quietly cross Discord's
// 1024-char-per-field limit again as commands are added (see GROUPS below).
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
} from 'discord.js';
import { config } from '../../config.js';

const COLOR = 0x5b7cfa;
const OVERVIEW_DESCRIPTION =
  'Slash commands are grouped by category below. Server features — moderation, logging, ' +
  'tickets, reaction roles, welcome, sticky messages, auto-moderation, counting, custom ' +
  'commands, autoresponder, auto-react, scheduled messages and leveling — are enabled and ' +
  'configured from the dashboard.';

// Command names grouped for display. Anything not listed still shows under
// "Other" (only if there's anything left over), so /help stays honest as
// commands are added. Discord caps an embed field/description at 1024
// characters — keep groups small enough that none can realistically cross
// it (buildCategoryEmbed() below also truncates defensively, so a
// miscounted group degrades instead of crashing the command).
export const GROUPS = [
  { name: 'General', commands: ['help', 'about', 'version', 'ping', 'stats'] },
  { name: 'Leveling', commands: ['rank', 'leaderboard'] },
  { name: 'Community', commands: ['afk', 'birthday'] },
  {
    name: 'Moderation',
    commands: [
      'kick',
      'ban',
      'unban',
      'timeout',
      'untimeout',
      'purge',
      'slowmode',
      'lock',
      'unlock',
      'lockdown',
      'warn',
      'modlog',
    ],
  },
  { name: 'Case log', commands: ['case', 'history'] },
  { name: 'Invites', commands: ['inviter', 'invites', 'invites-leaderboard'] },
  {
    name: 'Voice channels',
    commands: [
      'voice-claim',
      'voice-transfer',
      'voice-rename',
      'voice-limit',
      'voice-lock',
      'voice-unlock',
      'voice-hide',
      'voice-reveal',
      'voice-kick',
      'voice-ban',
      'voice-unban',
      'voice-owner',
      'voice-clean',
    ],
  },
  { name: 'Engagement', commands: ['giveaway', 'poll', 'poll-end', 'freegames'] },
  { name: 'Privacy', commands: ['mydata', 'forget'] },
];

const FIELD_LIMIT = 1024;
const COLLECTOR_TIMEOUT_MS = 5 * 60_000;

function commandLines(all, names) {
  return names
    .map((n) => all.get(n))
    .filter(Boolean)
    .map((c) => `\`/${c.data.name}\` — ${c.data.description}`);
}

/** Every command not covered by any GROUPS entry — empty when the list above is kept in sync. */
export function otherCommands(all) {
  const grouped = new Set(GROUPS.flatMap((g) => g.commands));
  return [...all.values()].filter((c) => !grouped.has(c.data.name));
}

function truncated(value) {
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT - 1)}…` : value;
}

function categories(all) {
  const list = GROUPS.map((g, i) => ({ key: String(i), name: g.name, lines: commandLines(all, g.commands) }));
  const other = otherCommands(all);
  if (other.length) {
    list.push({
      key: 'other',
      name: 'Other',
      lines: other.map((c) => `\`/${c.data.name}\` — ${c.data.description}`),
    });
  }
  return list.filter((c) => c.lines.length > 0);
}

function buildOverviewEmbed(cats) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Sylo — help')
    .setDescription(OVERVIEW_DESCRIPTION)
    .addFields({
      name: 'Categories',
      value: cats.map((c) => `**${c.name}** — ${c.lines.length} command(s)`).join('\n'),
    })
    .setFooter({ text: 'Pick a category below to see its commands.' });
}

function buildCategoryEmbed(cat) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`Sylo — help — ${cat.name}`)
    .setDescription(truncated(cat.lines.join('\n')))
    .setFooter({ text: 'Some moderation commands are hidden unless you have the matching permission.' });
}

function buildSelect(cats, selected) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help-category')
    .setPlaceholder('Choose a category…')
    .addOptions(
      { label: 'Overview', value: 'overview', default: selected === 'overview' },
      ...cats.map((c) => ({ label: c.name, value: c.key, default: selected === c.key }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildComponents(cats, selected, disabled = false) {
  const rows = [buildSelect(cats, selected)];
  if (disabled) rows[0].components[0].setDisabled(true);
  if (config.dashboardUrl) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Open dashboard')
          .setURL(config.dashboardUrl)
          .setDisabled(disabled)
      )
    );
  }
  return rows;
}

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show what Sylo can do and how to configure it.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const all = interaction.client.commands;
  const cats = categories(all);

  await interaction.reply({
    embeds: [buildOverviewEmbed(cats)],
    components: buildComponents(cats, 'overview'),
    flags: MessageFlags.Ephemeral,
  });

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
  });

  collector.on('collect', async (i) => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({
        content: "This isn't your help menu — run `/help` yourself.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const value = i.values[0];
    const embed =
      value === 'overview' ? buildOverviewEmbed(cats) : buildCategoryEmbed(cats.find((c) => c.key === value));
    await i.update({ embeds: [embed], components: buildComponents(cats, value) });
  });

  collector.on('end', () => {
    interaction.editReply({ components: buildComponents(cats, 'overview', true) }).catch(() => {});
  });
}
