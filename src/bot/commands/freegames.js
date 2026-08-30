// /freegames — show what's currently free to claim.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getFreeGames, gameEmbed } from '../../modules/freeGames.js';

export const data = new SlashCommandBuilder()
  .setName('freegames')
  .setDescription('Show games (or DLC) that are currently free to claim.')
  .addBooleanOption((o) =>
    o.setName('dlc').setDescription('Show free DLC / in-game content instead of games').setRequired(false)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const kind = interaction.options.getBoolean('dlc') ? 'dlc' : 'game';

  let items;
  try {
    items = await getFreeGames({ kind });
  } catch {
    return interaction.editReply('The free-games service is unavailable right now — try again later.');
  }
  if (items.length === 0) {
    return interaction.editReply(
      kind === 'dlc' ? 'No free DLC right now.' : 'Nothing is free to claim right now.'
    );
  }
  return interaction.editReply({ embeds: items.slice(0, 5).map(gameEmbed) });
}
