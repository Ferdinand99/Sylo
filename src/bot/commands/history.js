// /history <user> [page] — a member's moderation case log, newest first.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { listUserCases } from '../../db/modCases.js';
import { INFO_COLOR } from '../lib/moderation.js';

const PAGE = 8;

export const ACTION_LABELS = {
  warn: '⚠️ Warning',
  note: '📝 Note',
  timeout: '⏳ Timeout',
  untimeout: '⏳ Timeout lifted',
  kick: '👢 Kick',
  ban: '🔨 Ban',
  unban: '🔓 Unban',
};

/** "<@id>" for a snowflake moderator, else a friendly label. */
export function moderatorMention(id) {
  if (/^\d{17,20}$/.test(id)) return `<@${id}>`;
  return { automod: 'AutoMod', auto: 'auto-threshold', web: 'Dashboard', '': 'system' }[id] ?? id;
}

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription("Show a member's moderation history.")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
  .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const user = interaction.options.getUser('user', true);
  const asked = interaction.options.getInteger('page') ?? 1;
  const { rows, total } = listUserCases(interaction.guild.id, user.id, {
    limit: PAGE,
    offset: (asked - 1) * PAGE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(asked, pages);

  const embed = new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setAuthor({ name: `Moderation history — ${user.tag}`, iconURL: user.displayAvatarURL() })
    .setFooter({
      text: total ? `${total} case${total === 1 ? '' : 's'} · page ${page}/${pages}` : 'No cases on record',
    });

  if (!rows.length) {
    embed.setDescription(total ? 'That page is empty.' : 'This member has a clean record. 🎉');
  }
  for (const c of rows) {
    const label = ACTION_LABELS[c.action] ?? c.action;
    const detail = c.detail ? ` · ${c.detail}` : '';
    embed.addFields({
      name: `Case #${c.case_number} · ${label}${detail}`,
      value: `<t:${Math.floor(c.created_at / 1000)}:R> · by ${moderatorMention(c.moderator_id)}\n${
        c.reason || '_no reason given_'
      }`.slice(0, 1024),
    });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
