// /buy <item> — buy a shop item by name or by its number in /shop. On Discord the item box suggests
// names as you type. The command shows the item and its price and asks to confirm; the ✅ button
// (handled in shop.js) is what buys, with the price shown, through the same purchase() in
// modules/lib/shop.js as the shop menu and the web shop.
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { economyGate, reply } from '../lib/economyCmd.js';
import { confirmPayload, itemsForSale } from './shop.js';
import { buyProblem, pickItem, shopRefusalText } from '../../modules/lib/shop.js';
import { economySettings } from '../../modules/economy.js';

export const data = new SlashCommandBuilder()
  .setName('buy')
  .setDescription('Buy an item from the shop.')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('item')
      .setDescription('The name, or the number in /shop')
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(100)
  );

/** Discord's suggestions while typing: names of items for sale that contain the text. */
export async function autocomplete(interaction) {
  const { enabled } = await economySettings(interaction.guildId);
  if (!enabled) return interaction.respond([]);
  const text = String(interaction.options.getFocused() ?? '').toLowerCase();
  const items = (await itemsForSale(interaction.guildId))
    .filter((i) => !text || i.name.toLowerCase().includes(text))
    .slice(0, 25);
  return interaction.respond(items.map((i) => ({ name: i.name.slice(0, 100), value: i.name.slice(0, 100) })));
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const items = await itemsForSale(interaction.guildId);
  const found = pickItem(items, interaction.options.getString('item', true));
  if (!found.item) {
    return reply(
      interaction,
      found.ambiguous
        ? `More than one item matches: ${found.ambiguous.map((i) => `**${i.name}**`).join(', ')}. Use the number from /shop.`
        : 'There is no such item. See /shop.'
    );
  }
  // What can be seen before any money is asked is said now (paused, sold out, a role Sylo cannot give).
  const problem = buyProblem(interaction.guild, interaction.member, found.item);
  if (problem) return reply(interaction, shopRefusalText(problem, config));
  return reply(interaction, '', confirmPayload(found.item, config));
}
