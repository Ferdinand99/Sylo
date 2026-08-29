// /about — version plus uptime and runtime info, in an embed.
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { BUILD, REPO_URL } from '../lib/buildInfo.js';
import { formatDuration } from '../lib/duration.js';
import { uptimeSeconds } from '../../runtime.js';

export const data = new SlashCommandBuilder()
  .setName('about')
  .setDescription('Show Sylo version, uptime and runtime information.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const { client } = interaction;
  const heartbeat = Math.round(client.ws.ping);
  const memMb = process.memoryUsage().rss / 1024 / 1024;

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setAuthor({ name: `Sylo v${BUILD.version}`, iconURL: client.user.displayAvatarURL() })
    .setDescription('Multi-function Discord bot with a web dashboard.')
    .addFields(
      { name: 'Version', value: `\`${BUILD.version}\``, inline: true },
      { name: 'Uptime', value: formatDuration(uptimeSeconds() * 1000) || '0s', inline: true },
      { name: 'Gateway ping', value: heartbeat < 0 ? 'n/a' : `${heartbeat} ms`, inline: true },
      { name: 'Servers', value: String(client.guilds.cache.size), inline: true },
      { name: 'Memory', value: `${memMb.toFixed(0)} MB`, inline: true },
      { name: 'Runtime', value: `Node ${BUILD.node}\ndiscord.js ${BUILD.discordJs}`, inline: true }
    )
    .setFooter({ text: REPO_URL.replace('https://', '') })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
