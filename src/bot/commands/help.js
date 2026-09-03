// /help — overview of Sylo's commands and where to configure it.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from '../../config.js';

// Command names grouped for display. Anything not listed still shows under
// "Other", so /help stays honest as commands are added.
const GROUPS = [
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
  { name: 'Privacy', commands: ['mydata', 'forget'] },
];

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show what Sylo can do and how to configure it.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const all = interaction.client.commands;
  const seen = new Set();

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setTitle('Sylo — help')
    .setDescription(
      'Slash commands are below. Server features — moderation, logging, tickets, reaction ' +
        'roles, welcome, sticky messages, auto-moderation, counting, custom commands, ' +
        'autoresponder, scheduled messages and leveling — are enabled and configured from the ' +
        'dashboard.'
    );

  for (const group of GROUPS) {
    const lines = group.commands
      .map((n) => {
        seen.add(n);
        return all.get(n);
      })
      .filter(Boolean)
      .map((c) => `\`/${c.data.name}\` — ${c.data.description}`);
    if (lines.length) embed.addFields({ name: group.name, value: lines.join('\n') });
  }

  const other = [...all.values()].filter((c) => !seen.has(c.data.name));
  if (other.length) {
    embed.addFields({
      name: 'Other',
      value: other.map((c) => `\`/${c.data.name}\` — ${c.data.description}`).join('\n'),
    });
  }

  embed.setFooter({ text: 'Some moderation commands are hidden unless you have the matching permission.' });

  const reply = { embeds: [embed], flags: MessageFlags.Ephemeral };
  if (config.dashboardUrl) {
    reply.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open dashboard').setURL(config.dashboardUrl)
      ),
    ];
  }
  return interaction.reply(reply);
}
