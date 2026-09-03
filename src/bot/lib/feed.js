// A tiny, dependency-free parser for RSS 2.0 and Atom feeds. Regex-based rather
// than a real XML parser: feeds in the wild are messy, but the handful of fields
// we need sit shallow in each item/entry. Extracted from the YouTube-alerts
// module and generalised so both it and the RSS module share one code path.
//
// Feed bodies are remote and untrusted, so every regex is bounded: `grab` caps
// the string it scans, the lazy `[\s\S]` matches are length-limited, and
// parseFeed() caps the whole document. That keeps a hostile or truncated feed
// from turning a lazy match into quadratic backtracking.

const MAX_DOC = 4_000_000; // ~4 MB — far above any real feed
const MAX_SCAN = 300_000; // per grab() call
const MAX_FIELD = 200_000; // per CDATA / tag-text capture

/** First capture group of `re` in `s` (scanning at most MAX_SCAN chars), or null. */
export const grab = (re, s) => (String(s).slice(0, MAX_SCAN).match(re) || [])[1] || null;

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

/** Text content of the first `<tag>…</tag>` in `block` (CDATA-aware, decoded). */
function tagText(tag, block) {
  const raw = grab(
    new RegExp(`<${tag}(?:\\s[^>]{0,10000})?>([\\s\\S]{0,${MAX_FIELD}}?)</${tag}>`, 'i'),
    block
  );
  return raw == null ? '' : decodeEntities(stripCdata(raw));
}

/** A media/enclosure image URL from an item/entry block, if any. */
function imageFrom(block) {
  return (
    grab(/<media:thumbnail[^>]*\burl="([^"]+)"/i, block) ||
    grab(/<media:content[^>]*\burl="([^"]+)"[^>]*type="image\//i, block) ||
    grab(/<enclosure[^>]*\burl="([^"]+)"[^>]*type="image\//i, block) ||
    grab(/<itunes:image[^>]*\bhref="([^"]+)"/i, block) ||
    null
  );
}

function atomLink(block) {
  // Prefer rel="alternate" (or no rel); never rel="self" / "edit".
  const links = [...String(block).matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = (want) =>
    links.find((attrs) => {
      const rel = grab(/\brel="([^"]+)"/i, attrs);
      return want === null ? !rel : rel === want;
    });
  const attrs = pick('alternate') || pick(null) || links.find((a) => grab(/\brel="([^"]+)"/i, a) !== 'self');
  return attrs ? grab(/\bhref="([^"]+)"/i, attrs) : null;
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
  const feedAuthor = atom
    ? grab(/<feed[\s\S]*?<author>[\s\S]*?<name>([^<]*)<\/name>/i, s)
    : tagText('title', grab(/<channel>([\s\S]*?)(?:<item[\s>]|<\/channel>)/i, s) || '');

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
  for (const block of blocks) {
    const title = tagText('title', block) || 'Untitled';
    const link = atom ? atomLink(block) : tagText('link', block);
    const idTag = atom ? tagText('id', block) : tagText('guid', block);
    const dateStr = atom
      ? tagText('published', block) || tagText('updated', block)
      : tagText('pubDate', block) || tagText('dc:date', block) || tagText('date', block);
    const author =
      tagText('dc:creator', block) ||
      grab(/<author>[\s\S]*?<name>([^<]*)<\/name>/i, block) ||
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
