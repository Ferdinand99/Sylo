// Thread names for the Auto threads module. Pure and dependency-free, so the bot (modules/autoThreads.js)
// and the dashboard form (live preview) render a name with the same code.
//
// A template may use {author}, {date} and {words}:
//   {author}  the poster's display name
//   {date}    the day of the post, YYYY-MM-DD in UTC
//   {words}   the first six words of the post, with mentions and markdown stripped; when the post has
//             no words (a picture alone, only a mention) it is the author's name instead
// Anything else, {n} included, stays as written. Discord cuts a thread name at 100 characters.

export const THREAD_NAME_MAX = 100;
export const WORDS_SHOWN = 6;
export const DEFAULT_TEMPLATE = '{words}';
/** The auto-archive choices Discord offers, in minutes: 1 hour, 1 day, 3 days, 7 days. */
export const ARCHIVE_MINUTES = Object.freeze([60, 1440, 4320, 10080]);
export const DEFAULT_ARCHIVE_MINUTES = 1440;

/** Cut to `max` characters without splitting a surrogate pair (emoji). */
export function cut(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : Array.from(s).slice(0, max).join('');
}

// Control characters, zero-width characters and bidi overrides have no place in a name.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** One line of plain text: invisible characters gone, runs of whitespace collapsed. */
export function oneLine(text) {
  return String(text ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text of a post without Discord markup: mentions, custom emoji and timestamps are removed,
 * links keep their label, and the usual markdown marks (bold, italic, strikethrough, spoilers, code,
 * quotes, headings, list bullets) are dropped.
 */
export function plainText(content) {
  return String(content ?? '')
    .replace(/<(?:@[!&]?|#)\d+>/g, ' ') // user, role and channel mentions
    .replace(/<a?:\w+:\d+>/g, ' ') // custom emoji
    .replace(/<t:-?\d+(?::[a-zA-Z])?>/g, ' ') // timestamps
    .replace(/@(?:everyone|here)\b/g, ' ')
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1') // [label](url) -> label
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1') // <url> -> url
    .replace(/```[\w+-]*/g, ' ') // code fence marks, the code itself stays
    .replace(/^[ \t]*(?:#{1,3}|-#|>{1,3}|[-*+])[ \t]+/gm, '') // heading, quote, list marks
    .replace(/^[ \t]*>+/gm, '') // a quote mark without a space after it
    .replace(/\*+|~~|\|\||`/g, '') // bold, italic, strikethrough, spoiler, inline code
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1'); // _italic_ and __underline__ at word edges (snake_case stays)
}

/** The first `count` words of a post, as plain text. */
export function firstWords(content, count = WORDS_SHOWN) {
  return oneLine(plainText(content)).split(' ').filter(Boolean).slice(0, count).join(' ');
}

const dayOf = (when) => {
  const d = when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/**
 * The thread name for a post.
 * @param {string} template
 * @param {{ author?: string, createdAt?: number | Date, content?: string }} post
 * @returns {string} 1 to 100 characters, never empty
 */
export function renderThreadName(template, { author = '', createdAt = Date.now(), content = '' } = {}) {
  const who = oneLine(author) || 'Someone';
  const words = firstWords(content) || who;
  const values = { author: who, date: dayOf(createdAt), words };
  // One pass over the template: a value that itself looks like a placeholder (an author called
  // "{words}") is not expanded again.
  const named = String(template ?? '').trim() || DEFAULT_TEMPLATE;
  const name = oneLine(named.replace(/\{(author|date|words)\}/gi, (_, key) => values[key.toLowerCase()]));
  return oneLine(cut(name, THREAD_NAME_MAX)) || cut(who, THREAD_NAME_MAX);
}
