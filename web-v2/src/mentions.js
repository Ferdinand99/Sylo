// Mentions in message text, in the form Discord stores them: <#channelId>, <@&roleId>, <@userId>, plus the
// plain @everyone and @here. The dashboard lets a person pick one with # or @ and shows its name instead
// of the raw id; these functions are the pure half of that (finding what is being typed, inserting the
// token, reading a text back into names, filling the sample data of a preview).

const TOKEN = /<(#|@&|@!?)(\d{17,20})>|@(everyone|here)\b/g;

/** Whether a text holds any mention at all (a stored token, or a plain @everyone / @here). */
export function hasMentions(text) {
  return String(text ?? '').search(TOKEN) !== -1;
}

/** The kind of a stored token by its prefix. */
const KIND = { '#': 'channel', '@&': 'role', '@': 'user', '@!': 'user' };

/**
 * The text as a list of parts: { type: 'text', text } and { type: 'channel'|'role'|'user'|'special', id|name }.
 * @param {string} text
 */
export function parseMentions(text) {
  const out = [];
  let last = 0;
  const source = String(text ?? '');
  for (const m of source.matchAll(TOKEN)) {
    if (m.index > last) out.push({ type: 'text', text: source.slice(last, m.index) });
    if (m[3]) out.push({ type: 'special', name: m[3] });
    else out.push({ type: KIND[m[1]], id: m[2] });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}

/** The distinct mentions in a text, in order of first appearance (no plain text parts). */
export function mentionsIn(text) {
  const seen = new Set();
  const out = [];
  for (const part of parseMentions(text)) {
    if (part.type === 'text') continue;
    const key = `${part.type}:${part.id ?? part.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(part);
    }
  }
  return out;
}

/**
 * The name to show for a mention: '#general', '@Moderator', '@everyone'. A channel or role that is not in
 * the server any more is shown as such, never as an id; a member is '@member' until a name is known.
 * @param {{ type: string, id?: string, name?: string }} part
 * @param {{ channels?: Array<{id: string, name: string}>, roles?: Array<{id: string, name: string, color?: number}>, members?: Map<string, string> }} lookup
 */
export function mentionLabel(part, { channels = [], roles = [], members = new Map() } = {}) {
  if (part.type === 'special') return `@${part.name}`;
  if (part.type === 'channel') {
    const c = channels.find((x) => x.id === part.id);
    return c ? `#${c.name}` : '#deleted-channel';
  }
  if (part.type === 'role') {
    const r = roles.find((x) => x.id === part.id);
    return r ? `@${r.name}` : '@deleted-role';
  }
  const name = members.get(part.id);
  return name ? `@${name}` : '@member';
}

/** Whether the mention points at something that is gone (a deleted channel or role). */
export function mentionIsMissing(part, { channels = [], roles = [] } = {}) {
  if (part.type === 'channel') return !channels.some((x) => x.id === part.id);
  if (part.type === 'role') return !roles.some((x) => x.id === part.id);
  return false;
}

// ---- tokens inside the field ------------------------------------------------------------------------------

/**
 * Where the stored tokens (<#id>, <@&id>, <@id>) sit in a text, as { start, end, type, id }. The plain
 * @everyone and @here are not in the list: they are ordinary letters that happen to be a mention, so
 * the caret may stop inside them and Backspace removes one letter.
 */
export function tokenRanges(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(TOKEN)) {
    if (m[3]) continue;
    out.push({ start: m.index, end: m.index + m[0].length, type: KIND[m[1]], id: m[2] });
  }
  return out;
}

/** The token that ends exactly at `pos`, or null. */
export function tokenEndingAt(text, pos) {
  return tokenRanges(text).find((t) => t.end === pos) ?? null;
}

/** The token that starts exactly at `pos`, or null. */
export function tokenStartingAt(text, pos) {
  return tokenRanges(text).find((t) => t.start === pos) ?? null;
}

/**
 * A selection moved off the inside of a token. A caret inside one goes to the nearer edge; the ends of a
 * range that fall inside one move out to the edges, so a range never cuts a token in two.
 * @returns {[number, number]} the new start and end (the same as given when nothing is inside a token)
 */
export function snapSelection(text, start, end) {
  const tokens = tokenRanges(text);
  const inside = (pos) => tokens.find((t) => pos > t.start && pos < t.end);
  if (start === end) {
    const t = inside(start);
    if (!t) return [start, end];
    const to = start - t.start < t.end - start ? t.start : t.end;
    return [to, to];
  }
  const a = inside(start);
  const b = inside(end);
  return [a ? a.start : start, b ? b.end : end];
}

/**
 * The text of a field as the layer behind the caret draws it: plain text, the stored tokens (kept as the
 * raw text so the layer wraps exactly like the field, with the name as `label` to draw over it) and the
 * plain @everyone / @here. Nothing here is markup: every part is a string to render as text.
 * @returns {Array<{ kind: 'text'|'special', text: string } | { kind: 'mention', text: string, label: string, type: string, missing: boolean }>}
 */
export function mirrorParts(text, lookup = {}) {
  const source = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    if (m.index > last) out.push({ kind: 'text', text: source.slice(last, m.index) });
    if (m[3]) out.push({ kind: 'special', text: m[0] });
    else {
      const part = { type: KIND[m[1]], id: m[2] };
      out.push({
        kind: 'mention',
        text: m[0],
        label: mentionLabel(part, lookup),
        type: part.type,
        missing: mentionIsMissing(part, lookup),
      });
    }
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ kind: 'text', text: source.slice(last) });
  return out;
}

/**
 * What is being typed at the caret, if it is a # or @ mention: the character must start the text or follow
 * whitespace, and only name characters may follow it up to the caret.
 * @returns {{ kind: 'channel'|'mention', start: number, query: string } | null}
 */
export function triggerAt(text, caret) {
  const source = String(text ?? '');
  const end = Math.min(Number(caret) || 0, source.length);
  let i = end - 1;
  while (i >= 0 && /[\p{L}\p{N}_.-]/u.test(source[i])) i -= 1;
  if (i < 0) return null;
  const ch = source[i];
  if (ch !== '#' && ch !== '@') return null;
  if (i > 0 && !/\s/.test(source[i - 1])) return null;
  const query = source.slice(i + 1, end);
  if (query.length > 32) return null;
  return { kind: ch === '#' ? 'channel' : 'mention', start: i, query };
}

const norm = (s) => String(s ?? '').toLowerCase();

/** Channels whose name contains the query, names starting with it first. */
export function filterChannels(channels, query, max = 8) {
  const q = norm(query);
  return rank(channels, q, (c) => c.name).slice(0, max);
}

/** Roles (and @everyone / @here) matching the query, as { type, id|name, label } suggestions. */
export function filterRoles(roles, query, max = 8) {
  const q = norm(query);
  const specials = ['everyone', 'here']
    .filter((n) => n.startsWith(q))
    .map((name) => ({ type: 'special', name, label: `@${name}` }));
  const found = rank(roles, q, (r) => r.name).map((r) => ({
    type: 'role',
    id: r.id,
    label: `@${r.name}`,
    color: r.color,
  }));
  return [...found, ...specials].slice(0, max);
}

function rank(items, q, nameOf) {
  const starts = [];
  const contains = [];
  for (const item of items) {
    const n = norm(nameOf(item));
    if (!q || n.startsWith(q)) starts.push(item);
    else if (n.includes(q)) contains.push(item);
  }
  return [...starts, ...contains];
}

/** The text of a suggestion as it is stored. */
export function tokenOf(suggestion) {
  if (suggestion.type === 'channel') return `<#${suggestion.id}>`;
  if (suggestion.type === 'role') return `<@&${suggestion.id}>`;
  if (suggestion.type === 'user') return `<@${suggestion.id}>`;
  return `@${suggestion.name}`;
}

/**
 * The text after a suggestion is picked: the typed # or @ and the query are replaced by the token and one
 * space, and the caret goes after the space.
 */
export function insertMention(text, trigger, caret, token) {
  const source = String(text ?? '');
  const before = source.slice(0, trigger.start);
  const after = source.slice(Math.min(caret, source.length));
  const gap = /^\s/.test(after) ? '' : ' ';
  const value = `${before}${token}${gap}${after}`;
  return { value, caret: before.length + token.length + (gap ? 1 : 0) };
}

// ---- preview ---------------------------------------------------------------------------------------------

/** Sample values for the placeholders of the message fields; a form may add its own (`extra`). */
export function sampleValues({ server = 'Your server', extra = {} } = {}) {
  return {
    '{user}': { type: 'mention', text: '@Mara' },
    '{player}': { type: 'mention', text: '@Mara' },
    '{author}': { type: 'mention', text: '@Mara' },
    '{user.name}': 'Mara',
    '{user.tag}': 'mara',
    '{username}': 'mara',
    '{user.id}': '800000000000000010',
    '{server}': server,
    '{server.name}': server,
    '{server.id}': '900000000000000123',
    '{memberCount}': '1,284',
    '{level}': '12',
    '{age}': '27',
    '{role}': 'Verified',
    '{channel}': { type: 'mention', text: '#general' },
    '{count}': '1,284',
    '{index}': '3',
    '{args}': 'hello',
    '{name}': 'pixelharbor_live',
    '{title}': 'Pixel art night',
    '{game}': 'Celeste',
    '{url}': 'https://example.com',
    '{viewers}': '218',
    '{link}': 'https://example.com/post',
    '{feed}': 'Harbor blog',
    '{form}': 'Moderator application',
    '{reason}': 'Thanks for applying!',
    '{intro}': { type: 'mention', text: '#introductions' },
    ...extra,
  };
}

const BRACES = /\{[A-Za-z][A-Za-z0-9_.:-]*\}/g;

/**
 * A message template as render parts for a preview: placeholders become their sample values (a mention-like
 * value is marked), # and @ mentions become names, **bold** and `code` are marked. Unknown placeholders
 * stay as typed, as the real message would show them.
 * @returns {Array<{ kind: 'text'|'bold'|'code'|'mention'|'missing', text: string }>}
 */
export function previewParts(template, { samples = sampleValues(), lookup = {} } = {}) {
  const pieces = [];
  // 1. placeholders and mentions, in one pass over the text
  const source = String(template ?? '');
  const marks = [];
  for (const m of source.matchAll(BRACES)) marks.push({ at: m.index, len: m[0].length, ph: m[0] });
  for (const m of source.matchAll(TOKEN)) {
    const part = m[3] ? { type: 'special', name: m[3] } : { type: KIND[m[1]], id: m[2] };
    marks.push({ at: m.index, len: m[0].length, mention: part });
  }
  marks.sort((a, b) => a.at - b.at);
  let last = 0;
  for (const mark of marks) {
    if (mark.at < last) continue;
    if (mark.at > last) pieces.push({ kind: 'text', text: source.slice(last, mark.at) });
    if (mark.mention) {
      pieces.push({
        kind: mentionIsMissing(mark.mention, lookup) ? 'missing' : 'mention',
        text: mentionLabel(mark.mention, lookup),
      });
    } else {
      const value = samples[mark.ph];
      if (value === undefined) pieces.push({ kind: 'text', text: mark.ph });
      else if (typeof value === 'string') pieces.push({ kind: 'text', text: value });
      else pieces.push({ kind: 'mention', text: value.text });
    }
    last = mark.at + mark.len;
  }
  if (last < source.length) pieces.push({ kind: 'text', text: source.slice(last) });

  // 2. **bold** and `code` inside the plain text, after the neighbouring text pieces are joined (a
  // placeholder inside ** ** is plain text by now)
  const joined = [];
  for (const piece of pieces) {
    const prev = joined[joined.length - 1];
    if (piece.kind === 'text' && prev?.kind === 'text') prev.text += piece.text;
    else joined.push({ ...piece });
  }
  const out = [];
  for (const piece of joined) {
    if (piece.kind !== 'text') {
      out.push(piece);
      continue;
    }
    const rest = piece.text;
    const styled = /\*\*(.+?)\*\*|`([^`\n]+)`/g;
    let at = 0;
    for (const m of rest.matchAll(styled)) {
      if (m.index > at) out.push({ kind: 'text', text: rest.slice(at, m.index) });
      out.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : { kind: 'code', text: m[2] });
      at = m.index + m[0].length;
    }
    if (at < rest.length) out.push({ kind: 'text', text: rest.slice(at) });
  }
  return out;
}
