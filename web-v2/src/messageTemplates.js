// The built-in gallery of message templates: starting points for the message builder, the Welcome channel
// message, and the text fields of Welcome and the alerts. Nothing here is sent to the server: picking one
// only fills the form, which is saved the usual way.
//
// A template has one embed message (`embed`, used by the builder and the Welcome channel) and, where it
// makes sense, a short text for a field that holds plain text (`text`, by field). The text uses the
// {placeholders} of the field it goes into (placeholders.js lists them); the embed is written with {server},
// which `embedFor` keeps or rewords for a page that has no placeholders.

/**
 * @typedef {object} Template
 * @property {string} id
 * @property {string} name
 * @property {string} blurb         one line for the gallery
 * @property {{ content: string, embeds: object[] }} embed
 * @property {Record<string, string>} [text]   by field: welcome, welcomeDm, stream, youtubeVideo, youtubeLive, rss
 */

const embed = (fields) => ({ kind: 'embed', color: '#5865f2', ...fields });

/** @type {Template[]} */
export const TEMPLATES = [
  {
    id: 'rules',
    name: 'Rules',
    blurb: 'A numbered list of server rules.',
    embed: {
      content: '',
      embeds: [
        embed({
          title: '📜 Server rules',
          description:
            '**1.** Be kind and respectful. No harassment, hate or personal attacks.\n' +
            '**2.** Keep each topic in the right channel.\n' +
            '**3.** No spam, self-promotion or unrequested advertising.\n' +
            '**4.** No NSFW or illegal content.\n' +
            '**5.** Follow the moderators and the platform’s terms of service.',
          footerText: 'Breaking the rules can lead to a warning, a timeout or a ban.',
        }),
      ],
    },
    text: {
      welcome: 'Welcome to {server}, {user}! Before you post, please read the server rules.',
      welcomeDm:
        'Hi {user.name}, welcome to {server}! Please read the rules: be kind, keep topics in the right channel and no spam.',
    },
  },
  {
    id: 'welcome-card',
    name: 'Welcome card',
    blurb: 'A friendly welcome with where to start.',
    embed: {
      content: '',
      embeds: [
        embed({
          color: '#38c8f0',
          title: '👋 Welcome to {server}!',
          description: 'Glad you are here. Say hi, introduce yourself and have a look around.',
          fields: [
            { name: 'Start here', value: 'Read the rules and pick your roles.', inline: true },
            { name: 'Need help?', value: 'Ask any moderator.', inline: true },
          ],
          footerText: 'Enjoy your stay in {server}',
        }),
      ],
    },
    text: {
      welcome:
        'Welcome to {server}, {user}! You are member number {memberCount}. Say hi and make yourself at home.',
      welcomeDm: 'Hi {user.name}, welcome to {server}! If you need anything, just ask a moderator.',
    },
  },
  {
    id: 'announcement',
    name: 'Announcement',
    blurb: 'News with what, when and who it affects.',
    embed: {
      content: '',
      embeds: [
        embed({
          color: '#f59e0b',
          title: '📣 Announcement',
          description: 'Write your news here. Keep it short: what changed, who it affects and what to do.',
          fields: [
            { name: 'What', value: 'What is new or different.', inline: true },
            { name: 'When', value: 'The date or “from now on”.', inline: true },
          ],
          footerText: 'Posted by the team',
        }),
      ],
    },
    text: {
      youtubeVideo: '📣 New video from **{name}**: **{title}**\n{url}',
      rss: '📣 **{title}**\n{link}',
    },
  },
  {
    id: 'stream-live',
    name: 'Stream live',
    blurb: 'Tell everyone you are streaming.',
    embed: {
      content: '',
      embeds: [
        embed({
          color: '#9146ff',
          title: '🔴 Going live!',
          description: 'Come hang out and say hi in chat.\nhttps://twitch.tv/yourname',
          fields: [
            { name: 'Playing', value: 'Game name', inline: true },
            { name: 'Starts', value: 'Now', inline: true },
          ],
        }),
      ],
    },
    text: {
      stream: '🔴 **{name}** is live: **{title}**\nPlaying {game} · {viewers} watching\n{url}',
      youtubeLive: '🔴 **{name}** is live: **{title}**\n{url}',
    },
  },
  {
    id: 'giveaway',
    name: 'Giveaway',
    blurb: 'Prize, end time and how to enter.',
    embed: {
      content: '',
      embeds: [
        embed({
          color: '#ec4899',
          title: '🎉 Giveaway: Prize name',
          description:
            'React with 🎉 to enter!\n\n**Ends:** date and time\n**Winners:** 1\n**Hosted by:** your name',
          footerText: 'Good luck!',
        }),
      ],
    },
  },
  {
    id: 'event',
    name: 'Event',
    blurb: 'An event with when, where and who.',
    embed: {
      content: '',
      embeds: [
        embed({
          color: '#10b981',
          title: '📅 Event: Name',
          description: 'What the event is and who it is for.',
          fields: [
            { name: 'When', value: 'Date and time', inline: true },
            { name: 'Where', value: 'A voice channel or a link', inline: true },
            { name: 'Who', value: 'Everyone is welcome', inline: true },
          ],
          footerText: 'Reply here if you can join.',
        }),
      ],
    },
  },
];

/** The templates that have a text for this field (Welcome, the alerts). */
export const templatesForText = (field) => TEMPLATES.filter((t) => t.text?.[field]);

/**
 * The embed message of a template as a fresh copy to put in a form. `tokens` says whether the page fills
 * {server} in (the Welcome channel does, the embed message builder does not): without it the words are
 * written out, so the message never shows a placeholder as it is.
 */
export function embedFor(template, { tokens }) {
  const swap = (s) => (tokens ? s : s.replaceAll('{server}', 'our server'));
  const clone = structuredClone(template.embed);
  clone.content = swap(clone.content ?? '');
  for (const e of clone.embeds) {
    for (const key of ['title', 'description', 'footerText']) if (e[key]) e[key] = swap(e[key]);
    for (const f of e.fields ?? []) {
      f.name = swap(f.name);
      f.value = swap(f.value);
    }
  }
  return clone;
}
