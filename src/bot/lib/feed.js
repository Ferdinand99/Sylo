// A tiny, dependency-free parser for RSS 2.0 and Atom feeds. Scan-based rather
// than a real XML parser: feeds in the wild are messy, but the handful of fields
// we need sit shallow in each item/entry. Extracted from the YouTube-alerts
// module and generalised so both it and the RSS module share one code path.
//
// Feed bodies are remote and untrusted and parsing runs on the shared event
// loop, so it must cost time linear in the (capped) body. Every lookup below is
// a single left-to-right scan: tags are found with a literal-prefix regex, the
// end of a tag or element is found with an index that only ever moves forward,
// and attributes are read by a small tokenizer. No pattern nests an unbounded
// span inside another, because that is what lets a small crafted body (`<feed
// <author>` repeated, `<enclosure ` repeated, ...) cost seconds of backtracking.

const MAX_DOC = 4_000_000; // ~4 MB — far above any real feed
const MAX_ENTRIES = 100; // a feed of countless tiny items would mean a DB lookup per item per poll
const MAX_SCAN = 300_000; // per grab() call
const MAX_FIELD = 200_000; // per CDATA / tag-text capture
const MAX_TAG = 10_000; // longest opening tag we read attributes from
const MAX_LINKS = 50; // <link> elements considered per entry

/**
 * First capture group of `re` in `s` (scanning at most `maxScan` chars, default
 * MAX_SCAN), or null. Callers scraping something bigger than a feed body (e.g.
 * a full HTML page) can pass a larger `maxScan` explicitly — see youtubeAlerts.js.
 */
export const grab = (re, s, maxScan = MAX_SCAN) => (String(s).slice(0, maxScan).match(re) || [])[1] || null;

/** Unwrap a single wrapping CDATA section, if present. */
function stripCdata(s) {
  const m = String(s ?? '').match(/^\s*<!\[CDATA\[([\s\S]{0,200000}?)\]\]>\s*$/);
  return (m ? m[1] : String(s ?? '')).trim();
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decode the XML/HTML entities that show up in feed text — in a single pass, so
 * `&amp;lt;` decodes to the literal `&lt;` and never to `<`.
 */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/\\u0026/g, '&')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent) => {
      if (ent[0] === '#') {
        const cp = /^#x/i.test(ent) ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return safeFromCodePoint(cp);
      }
      return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
    });
}

function safeFromCodePoint(n) {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/**
 * Opening tags `<name ...>` in `s`, left to right, each as { attrs, end } where
 * `end` is the index just past the `>`. A tag is read up to the next `<` or `>`
 * (XML forbids `<` in attribute values), so a run of unterminated `<name `
 * starts is skipped in one pass instead of each one rescanning the rest.
 * Self-closing tags (`<name/>`) are reported too when `selfClosing` is set.
 */
function* openTags(s, name, selfClosing = false) {
  const re = new RegExp(`<${name}(?=[\\s>${selfClosing ? '/' : ''}])`, 'gi');
  const delim = /[<>]/g;
  let stop = -1; // index of the next '<' or '>' at or after the last tag start
  let m;
  while ((m = re.exec(s))) {
    const from = m.index + name.length + 1;
    if (stop < from) {
      delim.lastIndex = from;
      const d = delim.exec(s);
      if (!d) return; // no '<' or '>' left: no further tag can be complete
      stop = d.index;
    }
    if (s[stop] !== '>' || stop - from > MAX_TAG) continue;
    yield { attrs: s.slice(from, stop), end: stop + 1 };
  }
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Attributes of one tag as a lower-cased-name map, first occurrence wins. Linear. */
function parseAttrs(attrs) {
  const out = new Map();
  const n = attrs.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(attrs[i]) || attrs[i] === '/')) i++;
    const nameStart = i;
    while (i < n && !isSpace(attrs[i]) && attrs[i] !== '=' && attrs[i] !== '/') i++;
    const name = attrs.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(attrs[i])) i++;
    if (attrs[i] !== '=') {
      if (i === nameStart) i++; // nothing consumed (a stray character): step over it
      continue;
    }
    i++;
    while (i < n && isSpace(attrs[i])) i++;
    let value;
    const q = attrs[i];
    if (q === '"' || q === "'") {
      const close = attrs.indexOf(q, i + 1);
      if (close === -1) break;
      value = attrs.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < n && !isSpace(attrs[i])) i++;
      value = attrs.slice(valueStart, i);
    }
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** Text content of the first `<tag>…</tag>` in `block` (CDATA-aware, decoded). */
function tagText(tag, block) {
  const s = String(block).slice(0, MAX_SCAN);
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let close = null; // first closing tag at or after the current opening tag; only moves forward
  for (const open of openTags(s, tag)) {
    if (!close || close.index < open.end) {
      closeRe.lastIndex = open.end;
      close = closeRe.exec(s);
      if (!close) return '';
    }
    if (close.index - open.end <= MAX_FIELD)
      return decodeEntities(stripCdata(s.slice(open.end, close.index)));
  }
  return '';
}

/** Name inside the first `<author>` at or after `from`: `<author>…<name>X</name>`. */
function authorName(s, from = 0) {
  const author = /<author>/gi;
  author.lastIndex = from;
  const a = author.exec(s);
  if (!a) return null;
  const name = /<name>([^<]*)<\/name>/gi;
  name.lastIndex = a.index + a[0].length;
  return (name.exec(s) || [])[1] || null;
}

/** First attribute `want` (e.g. url) of the first matching `<tag>`; `ok` filters tags by their attributes. */
function firstAttr(s, tag, want, ok = () => true) {
  for (const { attrs } of openTags(s, tag, true)) {
    const a = parseAttrs(attrs);
    if (a.get(want) && ok(a)) return a.get(want);
  }
  return null;
}

/** A media/enclosure image URL from an item/entry block, if any. */
function imageFrom(block) {
  const s = String(block).slice(0, MAX_SCAN);
  const isImage = (a) => /^image\//i.test(a.get('type') || '');
  return (
    firstAttr(s, 'media:thumbnail', 'url') ||
    firstAttr(s, 'media:content', 'url', isImage) ||
    firstAttr(s, 'enclosure', 'url', isImage) ||
    firstAttr(s, 'itunes:image', 'href') ||
    null
  );
}

function atomLink(block) {
  // Prefer rel="alternate" (or no rel); never rel="self" / "edit".
  const s = String(block).slice(0, MAX_SCAN);
  const links = [];
  for (const { attrs } of openTags(s, 'link', true)) {
    links.push(parseAttrs(attrs));
    if (links.length >= MAX_LINKS) break;
  }
  const pick = (want) => links.find((a) => (want === null ? !a.get('rel') : a.get('rel') === want));
  const chosen = pick('alternate') || pick(null) || links.find((a) => a.get('rel') !== 'self');
  return chosen ? chosen.get('href') || null : null;
}

/** Feed-level author of an Atom document: the first `<author>` name after the first `<feed`. */
function atomFeedAuthor(s) {
  const doc = s.slice(0, MAX_SCAN);
  const feed = /<feed/i.exec(doc);
  return feed ? authorName(doc, feed.index + feed[0].length) : null;
}

/** RSS `<channel>` text up to its first `<item` (or `</channel>`): where the feed title lives. */
function channelHead(s) {
  const doc = s.slice(0, MAX_SCAN);
  const open = /<channel>/i.exec(doc);
  if (!open) return '';
  const from = open.index + open[0].length;
  const stop = /<item[\s>]|<\/channel>/gi;
  stop.lastIndex = from;
  const end = stop.exec(doc);
  return end ? doc.slice(from, end.index) : '';
}

/**
 * @typedef {Object} FeedEntry
 * @property {string} key        stable identity: guid / id / link / title
 * @property {string} title
 * @property {string} link
 * @property {number} published  epoch ms, 0 when absent
 * @property {string} author
 * @property {string|null} image
 * @property {string} block      the raw <item>/<entry> XML (for feed-specific fields)
 */

/**
 * Parse an RSS 2.0 or Atom document into entries, newest first.
 * @param {string} xml
 * @returns {FeedEntry[]}
 */
export function parseFeed(xml) {
  const s = String(xml ?? '').slice(0, MAX_DOC);
  const atom = /<feed[\s>]/i.test(s) && !/<rss[\s>]/i.test(s);
  const feedAuthor = atom ? atomFeedAuthor(s) : tagText('title', channelHead(s));

  const blocks = atom
    ? s
        .split(/<entry[\s>]/i)
        .slice(1)
        .map((b) => `<entry ${b}`)
    : s
        .split(/<item[\s>]/i)
        .slice(1)
        .map((b) => `<item ${b}`);

  const entries = [];
  for (const block of blocks.slice(0, MAX_ENTRIES)) {
    const title = tagText('title', block) || 'Untitled';
    const link = atom ? atomLink(block) : tagText('link', block);
    const idTag = atom ? tagText('id', block) : tagText('guid', block);
    const dateStr = atom
      ? tagText('published', block) || tagText('updated', block)
      : tagText('pubDate', block) || tagText('dc:date', block) || tagText('date', block);
    const author =
      tagText('dc:creator', block) ||
      authorName(String(block).slice(0, MAX_SCAN)) ||
      tagText('author', block) ||
      decodeEntities(feedAuthor || '');

    entries.push({
      key: idTag || link || title,
      title,
      link: link || '',
      published: Date.parse(dateStr || '') || 0,
      author: author || '',
      image: imageFrom(block),
      block,
    });
  }

  return entries.sort((a, b) => b.published - a.published);
}
