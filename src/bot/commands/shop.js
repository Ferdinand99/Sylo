// /shop — the server's shop: up to 10 items a page. On Discord an embed with paging buttons, a menu to
// pick an item to buy (with a confirmation), and a link to the web shop when staff turned it on. On
// Fluxer a numbered list that pages with the ⬅️ and ➡️ reactions (the buttons, rendered as reactions
// by the platform layer); items are bought with `!buy <number>` there.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config as appConfig } from '../../config.js';
import { balanceOf, formatMoney } from '../../modules/economy.js';
import { itemLabel, purchase, requirementsMet } from '../../modules/lib/shop.js';
import { getItem, listItems } from '../../db/economyShop.js';
import { economySettings } from '../../modules/economy.js';
import { guildKey, guildSupports } from '../../platform/platformOf.js';
import { registerComponent } from '../lib/components.js';
import { RESET_TEXT, economyGate } from '../lib/economyCmd.js';
import { ReactionInteraction } from '../framework/ReactionInteraction.js';
import { isResetRunning } from '../../modules/lib/economy.js';
import { purchaseText } from '../lib/shopText.js';

const PAGE_SIZE = 10;
const PREFIX = 'shop:';

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription("Browse the server's shop.")
  .setContexts(InteractionContextType.Guild);

/** The items a member sees: the ones for sale, in the staff's order. */
export const itemsForSale = async (guildId) => (await listItems(guildId)).filter((i) => i.enabled);

const stockText = (item) => {
  if (item.stock === null) return '';
  const left = Math.max(0, item.stock - item.sold);
  return left === 0 ? ' · sold out' : ` · ${left} left`;
};

/** One line of the list. A lock means a required role the member does not have. */
function lineOf(item, number, roleIds, config) {
  const lock = requirementsMet(item, roleIds) ? '' : '🔒 ';
  const kind =
    item.type === 'temp_role'
      ? ` (role for ${Math.round(item.durationMs / 3_600_000)}h)`
      : item.type === 'role'
        ? ' (role)'
        : '';
  const text = item.description ? `\n${item.description}` : '';
  return `**${number}.** ${lock}${itemLabel(item)}${kind} — ${formatMoney(item.price, config)}${stockText(item)}${text}`;
}

/**
 * The message for one page of the shop. `roleIds` are the viewer's roles (for the lock marks),
 * `callerId` is who asked (the paging buttons carry it, so the balance line stays theirs).
 */
export async function buildShop({ guild, guildId, config, page, callerId, roleIds }) {
  const items = await itemsForSale(guildId);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const at = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const shown = items.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);
  const bal = await balanceOf(guildId, callerId);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`Shop of ${guild?.name ?? 'this server'}`)
    .setDescription(
      shown.length
        ? shown.map((item, i) => lineOf(item, (at - 1) * PAGE_SIZE + i + 1, roleIds, config)).join('\n\n')
        : 'The shop is empty.'
    )
    .addFields({ name: 'Your cash', value: formatMoney(bal.cash, config) })
    .setFooter({ text: `Page ${at} of ${pages} · buy with /buy <name or number>` });

  const rows = [];
  const buttons = [];
  if (pages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}page:${at - 1}:${callerId}`)
        .setEmoji('⬅️')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(at <= 1),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}page:${at + 1}:${callerId}`)
        .setEmoji('➡️')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(at >= pages)
    );
  }
  if (config.webShop && appConfig.dashboardUrl) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Open the shop on the web')
        .setURL(`${appConfig.dashboardUrl}/shop/${encodeURIComponent(guildId)}`)
    );
  }
  if (buttons.length) rows.push(new ActionRowBuilder().addComponents(buttons));
  // A menu to pick an item: Discord only (on Fluxer its options would compete with the paging reactions).
  if (shown.length && guildSupports(guild, 'components')) {
    rows.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}pick`)
          .setPlaceholder('Pick an item to buy')
          .addOptions(
            shown.map((item, i) => ({
              label: `${(at - 1) * PAGE_SIZE + i + 1}. ${item.name}`.slice(0, 100),
              description: `${item.price.toLocaleString('en-US')} ${config.currencyName}`.slice(0, 100),
              value: String(item.id),
            }))
          )
      )
    );
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  return interaction.reply(
    await buildShop({
      guild: interaction.guild,
      guildId: interaction.guildId,
      config,
      page: 1,
      callerId: interaction.user.id,
      roleIds: [...(interaction.member?.roles?.cache?.keys?.() ?? [])],
    })
  );
}

// --- buttons and the menu ---------------------------------------------------------------------------------

const eph = (interaction, content, extra = {}) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...extra });

/**
 * The question before a purchase: the item and the price the member sees. The ✅ button carries that
 * price (`shop:buy:<item>:<price>`), and purchase() refuses when the item costs something else by
 * then. Shared by /buy and the menu.
 */
export function confirmPayload(item, config) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}buy:${item.id}:${item.price}`)
      .setEmoji('✅')
      .setLabel(`Buy for ${item.price.toLocaleString('en-US')}`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}no`)
      .setEmoji('❌')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
  return {
    content: `Buy **${itemLabel(item)}** for ${formatMoney(item.price, config)}?`,
    components: [row],
  };
}
registerComponent('economy', PREFIX, async (interaction) => {
  const parts = interaction.customId.split(':');
  const { enabled, config } = await economySettings(interaction.guildId);
  if (!enabled) return interaction.deferUpdate();
  const guildId = guildKey(interaction.guild);

  if (parts[1] === 'page') {
    if (!/^\d{1,20}$/.test(String(parts[3]))) return interaction.deferUpdate();
    return interaction.update(
      await buildShop({
        guild: interaction.guild,
        guildId,
        config,
        page: Number(parts[2]),
        callerId: parts[3],
        roleIds: [...(interaction.member?.roles?.cache?.keys?.() ?? [])],
      })
    );
  }

  if (parts[1] === 'pick') {
    const item = await getItem(guildId, Number(interaction.values?.[0]));
    if (!item || !item.enabled) return eph(interaction, 'That item is no longer for sale.');
    return eph(interaction, '', confirmPayload(item, config));
  }

  if (parts[1] === 'buy') {
    if (isResetRunning(guildId)) return eph(interaction, RESET_TEXT);
    // A purchase can take longer than Discord waits for an answer (it may give a role): answer first.
    await interaction.deferUpdate();
    const out = await purchase({
      guild: interaction.guild,
      member: interaction.member,
      itemId: Number(parts[2]),
      // The price on the button is the price the member saw; an old button without one never matches.
      expectedPrice: /^\d{1,15}$/.test(String(parts[3])) ? Number(parts[3]) : NaN,
      config,
    });
    const done = { content: purchaseText(out, config), components: [], allowedMentions: { parse: [] } };
    // On Fluxer the panel is a message with reactions: update it. On Discord edit the deferred reply.
    return interaction instanceof ReactionInteraction
      ? interaction.update(done)
      : interaction.editReply(done);
  }

  // 'no' and anything else: close the question
  return interaction.update({ content: 'Cancelled.', components: [] });
});
