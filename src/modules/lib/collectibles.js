// Collectibles in the Economy shop: the public address of a picture, the announcement of a purchase and the
// embeds of a member's collection. The rules of buying are in modules/lib/shop.js, the storage in
// db/economyShop.js, the pictures themselves in db/collectibleImages.js and what is accepted as a picture in
// lib/collectibleImage.js.
//
// A picture is served at <DASHBOARD_URL>/c/<id>.webp (routes/collectibleImage.js). Discord and Fluxer fetch an
// embed's image from there, so it needs no login; the id is 128 random bits. Without a DASHBOARD_URL there is no
// public address and a message goes out without the picture.
import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { config as appConfig } from '../../config.js';
import { rarityOf } from './economyConfig.js';
import { sendToChannel } from './send.js';
import { IMAGE_ID_RE } from '../../db/collectibleImages.js';

/** The public address of a picture, or null (no picture, or no DASHBOARD_URL to build an address from). */
export function imageUrl(imageId) {
  if (!appConfig.dashboardUrl || typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) return null;
  return `${appConfig.dashboardUrl}/c/${imageId}.webp`;
}

/** The label of a rarity key ("Rare"), or null for none. */
export const rarityLabel = (key) => rarityOf(key)?.label ?? null;

/** The embed colour of a rarity key, or the shop's gold for none. */
export const rarityColor = (key) => rarityOf(key)?.color ?? 0xf1c40f;

/** Everything a name must not be able to do in a message: format it, or ping with it. */
const plain = (text) => escapeMarkdown(String(text ?? '')).replaceAll('@', '@​');

const ANNOUNCE_TEMPLATE = '🎉 {user} bought {emoji}**{name}**{rarity}!';
const PLACEHOLDER = /\{(user|emoji|name|rarity)\}/g;

/**
 * The line that announces a purchase, filled in one pass: a name that itself looks like a placeholder (an
 * item called `{user}`) is shown as typed and not expanded again, and a name cannot format the line or ping.
 * Only the buyer is mentioned (`user`), and the message that carries it lets only that mention through.
 */
export function announcementLine({ userId, item }) {
  const label = rarityLabel(item.rarity);
  const values = {
    user: `<@${userId}>`,
    emoji: item.emoji ? `${plain(item.emoji)} ` : '',
    name: plain(item.name),
    rarity: label ? ` (${label})` : '',
  };
  return ANNOUNCE_TEMPLATE.replace(PLACEHOLDER, (_all, key) => values[key]);
}

/**
 * Announce a purchase of a collectible in the channel the staff chose, when the item has "Announce
 * purchases" on and a channel is set. The picture is the embed. Posted after the purchase committed; a
 * channel Sylo cannot post in is skipped without a word (the purchase stands). Only the buyer can be pinged.
 * @returns {Promise<boolean>} whether a message was sent
 */
export async function announcePurchase({ guildId, config, item, userId }) {
  if (item.type !== 'collectible' || !item.announce || !config.collectibleChannelId) return false;
  const url = imageUrl(item.imageId);
  const payload = {
    content: announcementLine({ userId, item }),
    allowedMentions: { parse: [], users: [userId] },
  };
  if (url) payload.embeds = [new EmbedBuilder().setColor(rarityColor(item.rarity)).setImage(url)];
  return sendToChannel(guildId, config.collectibleChannelId, payload);
}

/** One embed of a collection page: the item, how many copies, its rarity, with the picture as a thumbnail. */
export function collectionEmbed(entry) {
  const label = rarityLabel(entry.rarity);
  const embed = new EmbedBuilder()
    .setColor(rarityColor(entry.rarity))
    .setTitle(
      `${entry.emoji ? `${entry.emoji} ` : ''}${entry.name}${entry.count > 1 ? ` ×${entry.count}` : ''}`.slice(
        0,
        256
      )
    )
    .setDescription(
      [label, entry.removed ? 'item removed' : null, `since <t:${Math.floor(entry.firstAt / 1000)}:d>`]
        .filter(Boolean)
        .join(' · ')
    );
  const url = imageUrl(entry.imageId);
  if (url) embed.setThumbnail(url);
  return embed;
}
