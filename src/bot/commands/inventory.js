// /inventory [user] — what a member owns. Your own is shown in full and only you see it (on Discord);
// someone else's shows only the names of what they hold.
import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { listInventory } from '../../db/economyShop.js';
import { getTempRole } from '../../db/tempRoles.js';
import { itemLabelOfRow } from '../../modules/lib/shop.js';
import { economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription('Show what you own (or what another member holds).')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Whose items to show'));

const SHOWN = 25;

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const asked = interaction.options.getUser('user');
  const user = asked ?? interaction.user;
  if (user.bot) return reply(interaction, 'Bots do not have an account.');
  const own = user.id === interaction.user.id;

  const rows = (await listInventory(interaction.guildId, user.id, 200)).filter(
    (r) => r.status === 'active' || r.status === 'pending'
  );
  if (!rows.length)
    return reply(
      interaction,
      own ? 'You do not own anything yet. See /shop.' : 'They do not hold any items.'
    );

  const lines = [];
  for (const r of rows.slice(0, SHOWN)) {
    if (!own) {
      lines.push(`• ${itemLabelOfRow(r)}`);
      continue;
    }
    const bits = [`• **${itemLabelOfRow(r)}**`];
    if (r.itemType === 'temp_role' && r.roleId) {
      const t = await getTempRole(interaction.guildId, user.id, r.roleId);
      if (t) bits.push(`until <t:${Math.floor(t.expires_at / 1000)}:f>`);
    }
    if (r.itemType === 'custom') bits.push(r.fulfilledAt ? 'fulfilled' : 'waiting for staff');
    if (r.status === 'pending') bits.push('being set up');
    bits.push(`<t:${Math.floor(r.createdAt / 1000)}:d>`);
    lines.push(bits.join(' · '));
  }
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(own ? 'Your items' : 'Items held')
    .setDescription(lines.join('\n') + (rows.length > SHOWN ? `\n…and ${rows.length - SHOWN} more` : ''));
  return own
    ? reply(interaction, '', { embeds: [embed], content: undefined })
    : interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
