// Builds the Discord embed for a Battlefield stats lookup.
import { EmbedBuilder } from 'discord.js';

const BF_COLOR = 0x1b3a4b;

/** A field is only added when the value is present. */
function field(name, value, inline = true) {
  return value ? { name, value: String(value), inline } : null;
}

/**
 * @param {import('../../adapters/games/gameAdapter.js').PlayerStats} stats
 * @param {{ cached: boolean, cachedAt?: number }} [meta]
 * @returns {EmbedBuilder}
 */
export function buildBattlefieldStatsEmbed(stats, meta = { cached: false }) {
  const fields = [
    field('K/D', stats.kd),
    field('Win %', stats.winRate),
    field('Best Class', stats.bestClass),
    field('Kills', stats.kills),
    field('Deaths', stats.deaths),
    field('Accuracy', stats.accuracy),
    field('Kills / min', stats.killsPerMinute),
    field('Score / min', stats.scorePerMinute),
    field('Headshots', stats.headshots),
    field('Wins', stats.wins),
    field('Losses', stats.losses),
    field('Time Played', stats.timePlayed),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(BF_COLOR)
    .setTitle(`${stats.username} — ${stats.titleLabel}`)
    .setDescription(`Platform: \`${stats.platform}\`${stats.rank ? ` · Rank: **${stats.rank}**` : ''}`)
    .addFields(fields)
    .setTimestamp(stats.fetchedAt);

  if (stats.avatar) embed.setThumbnail(stats.avatar);
  if (stats.profileUrl) embed.setURL(stats.profileUrl);

  const freshness = meta.cached ? 'cached result' : 'live from gametools.network';
  embed.setFooter({ text: `Sylo · ${freshness}` });

  return embed;
}
