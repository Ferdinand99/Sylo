// Shared "the stream ended" handling for the Twitch / YouTube-live / Kick alert
// modules. On the live -> offline transition each module calls settleEndedPost()
// with the message it announced (from posted_keys) and the alert's `onEnd` mode.
import { EmbedBuilder } from 'discord.js';
import { formatDuration } from '../../bot/lib/duration.js';
import { deleteChannelMessage, editChannelMessage } from './send.js';

const ENDED_COLOR = 0x4b5563;

/**
 * The payload an announcement is edited down to when `onEnd: 'edit'`.
 * @param {{ name: string, url?: string, since?: number, plainText?: boolean }} o
 */
export function buildEndedPayload({ name, url, since, plainText }) {
  const forText = since ? formatDuration(Date.now() - since) : null;
  const headline = `⏹ ${name} — stream ended${forText ? ` · was live for ${forText}` : ''}`;

  if (plainText) {
    return { content: url ? `${headline}\n${url}` : headline, embeds: [], allowedMentions: { parse: [] } };
  }
  const embed = new EmbedBuilder().setColor(ENDED_COLOR).setTitle(headline).setTimestamp(Date.now());
  if (url) embed.setURL(url);
  return { content: '', embeds: [embed], allowedMentions: { parse: [] } };
}

/**
 * Act on the announcement message now that the stream is offline.
 * @param {object} o
 * @param {string} o.guildId
 * @param {'delete'|'edit'|'keep'} o.onEnd
 * @param {{ channelId: string|null, messageId: string|null, postedAt?: number } | null} o.post
 * @param {string} o.name
 * @param {string} [o.url]
 * @param {boolean} [o.plainText]
 */
export async function settleEndedPost({ guildId, onEnd, post, name, url, plainText }) {
  if (!post?.messageId || onEnd === 'keep') return;
  if (onEnd === 'edit') {
    await editChannelMessage(
      guildId,
      post.channelId,
      post.messageId,
      buildEndedPayload({ name, url, since: post.postedAt, plainText })
    );
    return;
  }
  await deleteChannelMessage(guildId, post.channelId, post.messageId);
}
