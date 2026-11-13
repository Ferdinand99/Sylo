// /collection [user] — the collectibles a member owns, one embed each with its picture, ten to a page. The pages
// turn with buttons on Discord and with the ⬅️ and ➡️ reactions on Fluxer (the same buttons, which the platform
// layer renders as reactions there).
//
// Who sees what is the "Members can show their collection" setting of the Economy module (off by default):
//   off  /collection shows only your own collection, and only you see the reply (a short-lived public reply on
//        Fluxer, which has no private replies). Asking for someone else's is refused.
//   on   the reply is public, and /collection <user> shows that member's collection.
// The page buttons carry the member whose collection it is. Every click is checked again: with the setting
// off, only that member may turn the pages (a public message from the time it was on does not stay open).
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { collectionPage } from '../../db/economyShop.js';
import { economySettings } from '../../modules/economy.js';
import { collectionEmbed } from '../../modules/lib/collectibles.js';
import { guildKey } from '../../platform/platformOf.js';
import { registerComponent } from '../lib/components.js';
import { economyGate, reply } from '../lib/economyCmd.js';

const PAGE_SIZE = 10;
const PREFIX = 'coll:';

export const data = new SlashCommandBuilder()
  .setName('collection')
  .setDescription('Show the collectibles you own (or another member owns).')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) =>
    o.setName('user').setDescription('Whose collection to show (when the server allows it)')
  );

/**
 * The message for one page of a collection, or null when the member owns no collectibles.
 * @param {{ guildId: string, userId: string, page: number }} args  userId is whose collection it is
 */
export async function buildCollection({ guildId, userId, page }) {
  const out = await collectionPage(guildId, userId, page, PAGE_SIZE);
  if (!out.kinds) return null;
  const head = `🗂️ **Collection of <@${userId}>** · ${out.copies} collectible${out.copies === 1 ? '' : 's'} · page ${out.page} of ${out.pages}`;
  const components =
    out.pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${PREFIX}${out.page - 1}:${userId}`)
              .setEmoji('⬅️')
              .setLabel('Previous')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(out.page <= 1),
            new ButtonBuilder()
              .setCustomId(`${PREFIX}${out.page + 1}:${userId}`)
              .setEmoji('➡️')
              .setLabel('Next')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(out.page >= out.pages)
          ),
        ]
      : [];
  return {
    content: head,
    embeds: out.entries.map(collectionEmbed),
    components,
    allowedMentions: { parse: [] },
  };
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  const asked = interaction.options.getUser('user');
  const user = asked ?? interaction.user;
  if (user.bot) return reply(interaction, 'Bots do not have an account.');
  const own = user.id === interaction.user.id;
  if (!own && !config.collectionPublic) {
    return reply(interaction, 'Collections are private in this server. Use /collection to see your own.');
  }
  const guildId = guildKey(interaction.guild);
  const payload = await buildCollection({ guildId, userId: user.id, page: 1 });
  // Off: only the member sees it. On: the member is showing it, so the reply is public.
  const send = (body) =>
    config.collectionPublic
      ? interaction.reply(body)
      : interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
  if (!payload) {
    return send({
      content: own
        ? 'You do not own any collectibles yet. See /shop.'
        : `<@${user.id}> does not own any collectibles.`,
      allowedMentions: { parse: [] },
    });
  }
  return send(payload);
}

// A page button: coll:<page>:<whose collection>. The page is clamped, so a stale button never shows an
// empty page, and the right to look is checked on every click.
registerComponent('economy', PREFIX, async (interaction) => {
  const [, page, targetId] = interaction.customId.split(':');
  const { enabled, config } = await economySettings(interaction.guildId);
  if (!enabled || !/^\d{1,20}$/.test(String(targetId))) return interaction.deferUpdate();
  if (interaction.user.id !== targetId && !config.collectionPublic) {
    return interaction.reply({
      content: 'Collections are private in this server.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  const payload = await buildCollection({
    guildId: guildKey(interaction.guild),
    userId: targetId,
    page: Number(page),
  });
  if (!payload) return interaction.deferUpdate();
  return interaction.update(payload);
});
