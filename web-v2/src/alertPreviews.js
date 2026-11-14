// What a social alert looks like in the channel, for the live preview next to the form. The shapes
// mirror what the bot posts (src/modules/twitchAlerts.js, kickAlerts.js, youtubeAlerts.js, rss.js):
// the message text in front (with the role ping), and under it a card the bot builds by itself. The
// card's own words are not editable, so only the message changes as the person types.
import { hostOf } from './util.js';

const SAMPLE_STREAMER = 'pixelharbor_live';
const SAMPLE_TITLE = 'Pixel art night';

// The message used when a plain-text alert has none of its own (the bot's DEFAULT_PLAIN_MESSAGE).
const PLAIN_DEFAULT = {
  twitch: '🔴 {name} is live on Twitch! {title} — {url}',
  kick: '🟢 {name} is live on Kick! {title} — {url}',
};
const COLOR = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0033', rss: '#ee802f' };
const SITE = { twitch: 'twitch.tv', kick: 'kick.com' };
const LABEL = { twitch: 'Twitch', kick: 'Kick' };

/** "<@&id> " in front of the message when a role is pinged, as the bot writes it. */
export const rolePing = (roleId) => (roleId ? `<@&${roleId}> ` : '');

/**
 * The preview of one streamer's go-live alert. `row` is { login | slug, roleId, message, plainText };
 * `defaultMessage` is the server's default for the embed style.
 */
export function streamPreview(platform, row, defaultMessage) {
  const handle = String((platform === 'kick' ? row.slug : row.login) ?? '').trim() || SAMPLE_STREAMER;
  const url = `https://${SITE[platform]}/${handle}`;
  const samples = { '{name}': handle, '{url}': url };
  const text = row.message || (row.plainText ? PLAIN_DEFAULT[platform] : defaultMessage) || '';
  let content = `${rolePing(row.roleId)}${text}`.trim();
  if (row.plainText && !text.includes('{url}')) content += `\n${url}`;
  return {
    key: 'alert',
    title: row.plainText ? `Alert for ${handle} (plain text)` : `Alert for ${handle}`,
    content,
    samples,
    embed: row.plainText
      ? null
      : {
          color: COLOR[platform],
          authorName: `${handle} is live on ${LABEL[platform]}`,
          title: SAMPLE_TITLE,
          description: 'Playing **Celeste** · 218 viewers',
        },
  };
}

/** The two YouTube alerts of one channel (a new video and going live), each left out when not chosen. */
export function youtubePreviews(row, defaults) {
  const name = String(row.name ?? '').trim() || 'Harbor Studio';
  const samples = { '{name}': name, '{url}': 'https://youtu.be/example' };
  const one = (key, title, text, authorName) => ({
    key,
    title: `${title} (${name})`,
    content: `${rolePing(row.roleId)}${text}`.trim(),
    samples,
    embed: { color: COLOR.youtube, authorName, title: SAMPLE_TITLE },
  });
  return [
    {
      ...one('video', 'New video', row.videoMessage || defaults.video || '', `${name} · new video`),
      hidden: row.notify === 'live',
    },
    {
      ...one('live', 'Went live', row.liveMessage || defaults.live || '', `${name} is live on YouTube`),
      hidden: row.notify === 'video',
    },
  ];
}

/** The preview of one feed's post. */
export function rssPreview(row, defaultTemplate) {
  const source = (row.type === 'url' ? hostOf(row.ref, '') : '') || String(row.ref ?? '').trim() || 'Harbor blog';
  return {
    key: 'post',
    title: `New post (${source})`,
    content: `${rolePing(row.roleId)}${row.template || defaultTemplate || ''}`.trim(),
    samples: { '{author}': 'Mara', '{feed}': source, '{link}': `https://${source}/post` },
    embed: { color: COLOR.rss, title: SAMPLE_TITLE, description: 'by Mara', footer: source },
  };
}
