// /stats — game statistics lookups, gated by the "Game stats" module.
//
// Ships the `battlefield` subcommand. Adding another game later means adding a
// sibling subcommand here plus its adapter file; the shared runStatsLookup()
// helper stays the same because it only talks to the adapter registry.
import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getAdapter } from '../../adapters/games/index.js';
import { AdapterError } from '../../adapters/games/gameAdapter.js';
import { isModuleEnabled } from '../../db/modules.js';
import { cacheKey, getCached, setCached } from '../../db/cache.js';
import { buildBattlefieldStatsEmbed } from '../embeds/battlefieldStats.js';
import { log } from '../../lib/log.js';

const BF_TITLES = [
  { name: 'Battlefield 1', value: 'bf1' },
  { name: 'Battlefield 3', value: 'bf3' },
  { name: 'Battlefield 4', value: 'bf4' },
  { name: 'Battlefield V', value: 'bfv' },
  { name: 'Battlefield Hardline', value: 'bfh' },
  { name: 'Battlefield 2042 (beta)', value: 'bf2042' },
  { name: 'Battlefield 6 (beta)', value: 'bf6' },
];

/** Same list, exported for the dashboard's per-guild default-title setting. */
export const BF_TITLE_CHOICES = BF_TITLES;

// Superset of platform ids across all Battlefield titles. The adapter validates
// the title/platform combination and returns a friendly error for mismatches.
const BF_PLATFORMS = [
  { name: 'PC', value: 'pc' },
  { name: 'PlayStation 4', value: 'ps4' },
  { name: 'PlayStation 5', value: 'ps5' },
  { name: 'Xbox One', value: 'xboxone' },
  { name: 'Xbox Series X|S', value: 'xbsx' },
  { name: 'PlayStation 3', value: 'ps3' },
  { name: 'Xbox 360', value: 'xbox360' },
];

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Look up player statistics for a supported game.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('battlefield')
      .setDescription('Battlefield-series player stats (BF1, BF3, BF4, BFV, Hardline, and more).')
      .addStringOption((opt) =>
        opt
          .setName('title')
          .setDescription('Which Battlefield title')
          .setRequired(true)
          .addChoices(...BF_TITLES)
      )
      .addStringOption((opt) =>
        opt.setName('username').setDescription('In-game player name').setRequired(true).setMaxLength(100)
      )
      .addStringOption((opt) =>
        opt
          .setName('platform')
          .setDescription('Player platform')
          .setRequired(true)
          .addChoices(...BF_PLATFORMS)
      )
  );

/**
 * Shared lookup path for any game: check cache, else fetch via the adapter and
 * cache the result. Returns the normalized stats plus cache metadata.
 * @param {string} game     Adapter id, e.g. "battlefield".
 * @param {string} title    Title id, e.g. "bf4".
 * @param {string} username
 * @param {string} platform
 */
async function runStatsLookup(game, title, username, platform) {
  const key = cacheKey(title, platform, username);

  const hit = getCached(key);
  if (hit) return { stats: hit.payload, cached: true, cachedAt: hit.cachedAt };

  const adapter = getAdapter(game);
  const stats = await adapter.getPlayerStats(username, platform, { title });
  setCached(key, { game, title, username: stats.username, platform }, stats);
  return { stats, cached: false };
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'game-stats')) {
    return interaction.reply({
      content: 'The **Game stats** module is not enabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply();

  if (sub === 'battlefield') {
    const title = interaction.options.getString('title', true);
    const username = interaction.options.getString('username', true).trim();
    const platform = interaction.options.getString('platform', true);

    try {
      const { stats, cached } = await runStatsLookup('battlefield', title, username, platform);
      const embed = buildBattlefieldStatsEmbed(stats, { cached });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err instanceof AdapterError) {
        await interaction.editReply({ content: `⚠️ ${err.userMessage}` });
        return;
      }
      // Unexpected — record it and show a generic message. Never rethrow.
      log.error('stats', 'Unexpected error:', err);
      await interaction.editReply({
        content: '⚠️ Something went wrong fetching those stats. Please try again later.',
      });
    }
    return;
  }

  await interaction.editReply({ content: `Unknown subcommand: \`${sub}\`` });
}
