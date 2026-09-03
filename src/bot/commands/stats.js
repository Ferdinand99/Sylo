// /stats — game statistics lookups, gated by the "Game stats" module.
//
// One flat command: pick the game from the `game` dropdown, give a `username`,
// and (for Battlefield) a `platform` — or (for RuneScape) an optional account
// type. Each `game` choice encodes `<adapter>:<title>`; the shared
// runStatsLookup() helper only ever talks to the adapter registry, so adding a
// game is a new adapter file plus one choice here.
import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getAdapter } from '../../adapters/games/index.js';
import { AdapterError } from '../../adapters/games/gameAdapter.js';
import { isModuleEnabled } from '../../db/modules.js';
import { cacheKey, getCached, setCached } from '../../db/cache.js';
import { buildBattlefieldStatsEmbed } from '../embeds/battlefieldStats.js';
import { buildRunescapeStatsEmbed } from '../embeds/runescapeStats.js';
import { log } from '../../lib/log.js';

// `value` is "<adapter>:<title>". Order: Battlefield newest-to-oldest, then RS.
const GAME_CHOICES = [
  { name: 'Battlefield 2042', value: 'battlefield:bf2042' },
  { name: 'Battlefield 6', value: 'battlefield:bf6' },
  { name: 'Battlefield V', value: 'battlefield:bfv' },
  { name: 'Battlefield 4', value: 'battlefield:bf4' },
  { name: 'Battlefield 1', value: 'battlefield:bf1' },
  { name: 'Battlefield 3', value: 'battlefield:bf3' },
  { name: 'Battlefield Hardline', value: 'battlefield:bfh' },
  { name: 'Old School RuneScape', value: 'runescape:osrs' },
  { name: 'RuneScape 3', value: 'runescape:rs3' },
];

// One dropdown covering both Battlefield platforms and RuneScape account types.
// The chosen adapter validates the combination and returns a friendly error.
const PLATFORM_CHOICES = [
  { name: 'PC', value: 'pc' },
  { name: 'PlayStation 5', value: 'ps5' },
  { name: 'PlayStation 4', value: 'ps4' },
  { name: 'Xbox Series X|S', value: 'xbsx' },
  { name: 'Xbox One', value: 'xboxone' },
  { name: 'PlayStation 3', value: 'ps3' },
  { name: 'Xbox 360', value: 'xbox360' },
  { name: 'RuneScape: Ironman', value: 'ironman' },
  { name: 'RuneScape: Hardcore Ironman', value: 'hardcore' },
  { name: 'RuneScape: Ultimate Ironman', value: 'ultimate' },
];

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Look up player statistics for a supported game.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Which game to look up')
      .setRequired(true)
      .addChoices(...GAME_CHOICES)
  )
  .addStringOption((opt) =>
    opt.setName('username').setDescription('In-game player name').setRequired(true).setMaxLength(100)
  )
  .addStringOption((opt) =>
    opt
      .setName('platform')
      .setDescription('Battlefield: platform (required). RuneScape: account type (optional).')
      .setRequired(false)
      .addChoices(...PLATFORM_CHOICES)
  );

/**
 * Shared lookup path for any game: check cache, else fetch via the adapter and
 * cache the result. Returns the normalized stats plus cache metadata.
 * @param {string} game     Adapter id, e.g. "battlefield".
 * @param {string} title    Title id, e.g. "bf4" or "osrs".
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

  const [game, title] = interaction.options.getString('game', true).split(':');
  const username = interaction.options.getString('username', true).trim();
  let platform = interaction.options.getString('platform') ?? '';

  await interaction.deferReply();

  if (game === 'battlefield' && !platform) {
    await interaction.editReply({ content: '⚠️ Pick a **platform** for Battlefield lookups.' });
    return;
  }
  if (game === 'runescape' && !['ironman', 'hardcore', 'ultimate'].includes(platform)) {
    platform = 'main'; // default to the normal hiscores
  }

  try {
    const { stats, cached } = await runStatsLookup(game, title, username, platform);
    const embed =
      game === 'runescape'
        ? buildRunescapeStatsEmbed(stats, { cached })
        : buildBattlefieldStatsEmbed(stats, { cached });
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
}
