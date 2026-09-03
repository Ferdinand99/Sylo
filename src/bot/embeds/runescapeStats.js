// Builds the Discord embed for a RuneScape hiscores lookup (OSRS / RS3).
import { EmbedBuilder } from 'discord.js';

const RS_COLOR = 0xc8aa6e;
const MAX_SKILL_FIELDS = 6;
const MAX_ACTIVITIES = 8;

const int = (n) => Number(n).toLocaleString('en-US');

/**
 * @param {import('../../adapters/games/gameAdapter.js').PlayerStats} stats
 * @param {{ cached: boolean }} [meta]
 * @returns {EmbedBuilder}
 */
export function buildRunescapeStatsEmbed(stats, meta = { cached: false }) {
  const topSkills = [...(stats.skills ?? [])]
    .filter((s) => s.level > 0)
    .sort((a, b) => b.level - a.level || b.xp - a.xp)
    .slice(0, MAX_SKILL_FIELDS)
    .map((s) => ({ name: s.name, value: `Lv ${s.level} · ${int(s.xp)} xp`, inline: true }));

  const activities = [...(stats.activities ?? [])]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIVITIES)
    .map((a) => `**${a.name}** — ${int(a.score)}`);

  const summary = [
    stats.combatLevel ? `Combat **${stats.combatLevel}**` : null,
    stats.totalLevel ? `Total level **${stats.totalLevel}**` : null,
    stats.totalXp ? `Total XP **${stats.totalXp}**` : null,
    stats.overallRank ? `Rank ${stats.overallRank}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const embed = new EmbedBuilder()
    .setColor(RS_COLOR)
    .setTitle(`${stats.username} — ${stats.titleLabel}`)
    .setDescription(summary || 'No ranked stats on the hiscores.')
    .setTimestamp(stats.fetchedAt);

  if (topSkills.length) embed.addFields(topSkills);
  if (activities.length) {
    embed.addFields({ name: 'Bosses & activities', value: activities.join('\n'), inline: false });
  }
  if (stats.avatar) embed.setThumbnail(stats.avatar);
  if (stats.profileUrl) embed.setURL(stats.profileUrl);

  embed.setFooter({
    text: `Sylo · ${meta.cached ? 'cached result' : 'live from RuneScape Hiscores'}`,
  });

  return embed;
}
