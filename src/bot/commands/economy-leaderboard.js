// /economy-leaderboard — the richest members by cash + bank, ten to a page, with the caller's own
// rank. (/leaderboard is the Leveling module's, so this one carries the module's name.) The pages
// turn with buttons on Discord and with the ⬅️ and ➡️ reactions on Fluxer: the same two buttons,
// which the platform layer renders as reactions there.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { balanceOf, economySettings, formatMoney, leaderboardPage } from '../../modules/economy.js';
import { registerComponent } from '../lib/components.js';
import { economyGate } from '../lib/economyCmd.js';

const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const BUTTON_PREFIX = 'ecolb:';

export const data = new SlashCommandBuilder()
  .setName('economy-leaderboard')
  .setDescription('Show the richest members of this server.')
  .setContexts(InteractionContextType.Guild);

/**
 * The message for one page: an embed (names are mentions, which clients draw as names) and the
 * previous/next buttons. `callerId` is who asked, whose rank the footer line shows.
 */
export async function buildLeaderboard({ guild, guildId, config, page, callerId }) {
  const board = await leaderboardPage(guildId, page, PAGE_SIZE);
  const mine = await balanceOf(guildId, callerId);
  const lines = board.rows.map(
    (r) => `${MEDALS[r.rank - 1] ?? `**${r.rank}.**`} <@${r.userId}> — ${formatMoney(r.total, config)}`
  );
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`Richest members of ${guild?.name ?? 'this server'}`)
    .setDescription(lines.length ? lines.join('\n') : 'Nobody has any money yet.')
    .addFields({
      name: 'Rank',
      value: mine.rank
        ? `<@${callerId}>: #${mine.rank} with ${formatMoney(mine.total, config)}`
        : `<@${callerId}> has no account yet.`,
    })
    .setFooter({ text: `Page ${board.page} of ${board.pages} · ${board.total} member(s) with an account` });
  const components =
    board.pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${BUTTON_PREFIX}${board.page - 1}:${callerId}`)
              .setEmoji('⬅️')
              .setLabel('Previous')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(board.page <= 1),
            new ButtonBuilder()
              .setCustomId(`${BUTTON_PREFIX}${board.page + 1}:${callerId}`)
              .setEmoji('➡️')
              .setLabel('Next')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(board.page >= board.pages)
          ),
        ]
      : [];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  return interaction.reply(
    await buildLeaderboard({
      guild: interaction.guild,
      guildId: interaction.guildId,
      config,
      page: 1,
      callerId: interaction.user.id,
    })
  );
}

// A page button: `ecolb:<page>:<who asked>`. Anyone may turn the pages; the rank line stays the
// asker's. The page number is clamped, so a stale button never shows an empty page.
registerComponent('economy', BUTTON_PREFIX, async (interaction) => {
  const [, page, callerId] = interaction.customId.split(':');
  const { enabled, config } = await economySettings(interaction.guildId);
  if (!enabled || !/^\d{1,20}$/.test(String(callerId))) return interaction.deferUpdate();
  return interaction.update(
    await buildLeaderboard({
      guild: interaction.guild,
      guildId: interaction.guildId,
      config,
      page: Number(page),
      callerId,
    })
  );
});
