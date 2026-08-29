// /version — report the release of Sylo this instance is running.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { BUILD } from '../lib/buildInfo.js';

export const data = new SlashCommandBuilder()
  .setName('version')
  .setDescription('Show the version of Sylo this server is running.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  await interaction.reply({
    content: `Sylo **v${BUILD.version}**`,
    flags: MessageFlags.Ephemeral,
  });
}
