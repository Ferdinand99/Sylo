// Placeholder ({token}) helpers for the template fields. Every module that fills tokens in a message or
// a name does it with its own list; the lists below mirror what the server really replaces (the
// replaceAll calls in src/modules/*.js and src/lib/autoThreadName.js). Names are not unified yet.

/** One supported token: the text that is inserted, and a short plain description for the tooltip. */
const t = (token, hint) => ({ token, hint });

export const PLACEHOLDER_SETS = {
  welcome: [
    t('{user}', 'Mentions the member'),
    t('{user.tag}', "The member's name and tag"),
    t('{user.name}', "The member's username"),
    t('{user.id}', "The member's ID"),
    t('{server}', 'The server name'),
    t('{memberCount}', 'How many members the server has'),
    t('{intro}', 'Mentions the introductions channel (empty when Introductions is off)'),
    t('{role}', 'The role that started the welcome (empty when members are welcomed on joining)'),
  ],
  welcomeChannel: [
    t('{server}', 'The server name'),
    t('{server.name}', 'The server name'),
    t('{server.id}', 'The server ID'),
    t('{memberCount}', 'How many members the server has'),
  ],
  leveling: [
    t('{player}', 'Mentions the member'),
    t('{user}', 'Mentions the member'),
    t('{username}', "The member's username"),
    t('{level}', 'The level they reached'),
    t('{server}', 'The server name'),
  ],
  birthdays: [
    t('{user}', 'Mentions the member'),
    t('{age}', 'Their age (blank unless they gave a birth year)'),
  ],
  introductions: [
    t('{user}', 'Mentions the member'),
    t('{user.name}', "The member's display name"),
    t('{server}', 'The server name'),
  ],
  applications: [
    t('{user}', "The member's name"),
    t('{server}', 'The server name'),
    t('{form}', 'The name of the form'),
    t('{reason}', 'The reason staff gave (a short note when there is none)'),
  ],
  tickets: [t('{server}', 'The server name')],
  autoresponder: [
    t('{user}', 'Mentions the member'),
    t('{username}', "The member's username"),
    t('{server}', 'The server name'),
    t('{channel}', 'Mentions the channel'),
  ],
  customCommands: [
    t('{user}', 'Mentions the member'),
    t('{username}', "The member's username"),
    t('{server}', 'The server name'),
    t('{channel}', 'Mentions the channel'),
    t('{args}', 'The text typed after the command'),
  ],
  // The first reply in a new thread only knows the poster.
  autoThreadsFirstReply: [t('{author}', 'Mentions the person who posted')],
  autoThreadsName: [
    t('{author}', 'The name of the person who posted'),
    t('{date}', 'The day of the post (UTC)'),
    t('{words}', 'The first 6 words of the post'),
  ],
  presence: [
    t('{servers}', 'How many servers Sylo is in'),
    t('{members}', 'How many members those servers have in total'),
  ],
  serverStats: [t('{count}', 'The current number')],
  tempVoice: [
    t('{index}', 'The channel number (1, 2, 3 …)'),
    t('{count}', 'The channel number (1, 2, 3 …)'),
    t('{username}', "The owner's username"),
    t('{user}', "The owner's display name"),
  ],
  twitch: [
    t('{name}', 'The streamer'),
    t('{title}', 'The stream title'),
    t('{game}', 'What they are playing'),
    t('{url}', 'Link to the stream'),
    t('{viewers}', 'How many are watching'),
  ],
  kick: [
    t('{name}', 'The streamer'),
    t('{title}', 'The stream title'),
    t('{game}', 'What they are playing'),
    t('{url}', 'Link to the stream'),
    t('{viewers}', 'How many are watching'),
  ],
  youtube: [
    t('{name}', 'The channel name'),
    t('{title}', 'The video title'),
    t('{url}', 'Link to the video'),
  ],
  rss: [
    t('{title}', 'The post title'),
    t('{link}', 'Link to the post'),
    t('{author}', 'Who wrote it'),
    t('{feed}', 'The feed name'),
  ],
};

/**
 * The tokens a form offers. `fromApi` is the list the server sends (plain '{token}' strings) when it
 * sends one; it wins over the built-in set so the form never offers more or less than the server
 * does, and the built-in hints are reused for the tokens it knows.
 */
export function tokensFor(setName, fromApi) {
  const known = PLACEHOLDER_SETS[setName] ?? [];
  if (!Array.isArray(fromApi) || !fromApi.length) return known;
  return fromApi.map((token) => known.find((k) => k.token === token) ?? { token, hint: '' });
}

const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g;

/** Every distinct `{token}` written in the text, in order of first appearance. */
export function findTokens(text) {
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) seen.add(m[0]);
  return [...seen];
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The supported token closest to an unknown one, or null when nothing is close enough. */
export function closestToken(unknown, supported) {
  const want = squash(unknown);
  if (!want) return null;
  const list = supported.map((s) => (typeof s === 'string' ? s : s.token));
  const exact = list.find((s) => squash(s) === want);
  if (exact) return exact;
  let best = null;
  let bestDistance = Infinity;
  for (const s of list) {
    const d = distance(want, squash(s));
    if (d < bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  const limit = Math.max(1, Math.floor(want.length / 3));
  return best && bestDistance <= limit ? best : null;
}

/**
 * `{token}`s in the text that this field does not fill in, each with the closest supported token (or
 * null). `ignoreCase` is for fields the server fills case-insensitively (the thread name).
 * @returns {{ token: string, suggestion: string | null }[]}
 */
export function unknownTokens(text, supported, { ignoreCase = false } = {}) {
  const list = supported.map((s) => (typeof s === 'string' ? s : s.token));
  const has = (tok) =>
    ignoreCase ? list.some((s) => s.toLowerCase() === tok.toLowerCase()) : list.includes(tok);
  return findTokens(text)
    .filter((tok) => !has(tok))
    .map((tok) => ({ token: tok, suggestion: closestToken(tok, list) }));
}

/**
 * The text with the token put in exactly at the caret (or over the selection), and where the caret
 * goes next. `start` and `end` default to the end of the text.
 */
export function insertAtCursor(value, token, start, end) {
  const text = String(value ?? '');
  const from = Number.isInteger(start) ? Math.min(start, text.length) : text.length;
  const to = Number.isInteger(end) ? Math.min(Math.max(end, from), text.length) : from;
  return { value: `${text.slice(0, from)}${token}${text.slice(to)}`, caret: from + token.length };
}
