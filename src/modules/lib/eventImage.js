// The images on a public event page: the server's icon and the event's image. The page never lets a
// visitor's browser call anyone but Sylo. Instead Sylo fetches the image itself and serves it at
// /events/<token>/icon and /events/<token>/image (src/web/routes/events.js), so the HTML holds only
// that address: no third-party host, and none of the ids in a Discord image address
// (/icons/<server id>/..., /attachments/<channel id>/..., /avatars/<user id>/...).
//
// What Sylo will fetch, and how:
//  - only https links on Discord's own image hosts (trustedImageUrl), no port, no credentials;
//  - through safeFetch, which refuses a host that resolves to a private address, with no redirect
//    followed (a redirect is a failure), at most MAX_IMAGE_BYTES, and a timeout;
//  - only if the answer is a 200 with PNG, JPEG, GIF or WebP, by the content type and by the first
//    bytes of the file. SVG is refused, and the type that is served is the one the bytes show.
// A failure of any kind (an expired Discord link, a slow answer, a wrong type) means no image: the
// page leaves it out.
//
// Answers are kept in memory for a short while so a page that is opened often does not make Sylo
// fetch the same image every time. The memory is bounded: at most MAX_ENTRIES entries and
// MAX_TOTAL_BYTES of image data; a failure is remembered for a shorter time.
//
// One server must not be able to use all of it, or to make Sylo download over and over. Every entry
// belongs to the server (the `owner`) whose page asked for it:
//  - a server may hold at most MAX_OWNER_BYTES and MAX_OWNER_ENTRIES; past that its own oldest
//    entries go, never another server's;
//  - when the whole memory is full, the entries of the server that holds the most go first;
//  - a server may start at most OWNER_FETCHES_PER_MINUTE downloads a minute (a failure counts), and
//    the whole instance at most MAX_CONCURRENT_DOWNLOADS at once. A request over those limits
//    gets no image (the page leaves it out) and starts no download.
// So a server with more large images than its share only ever refetches its own, at a bounded rate.
// An entry that has passed its time is also removed, not just ignored: a sweep runs every
// SWEEP_MS (and on every use), so nothing stays in memory more than about a minute past its time.
import { safeFetch } from '../../lib/safeFetch.js';
import { every } from '../schedule.js';
import { trustedImageUrl } from './eventPage.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 5000;
export const OK_TTL_MS = 10 * 60_000;
export const FAILED_TTL_MS = 60_000;
export const SWEEP_MS = 60_000;
export const MAX_ENTRIES = 64;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** One server's share of the memory. */
export const MAX_OWNER_BYTES = 4 * 1024 * 1024;
export const MAX_OWNER_ENTRIES = 16;
/** Downloads one server may start per minute, and downloads running at once for all servers. */
export const OWNER_FETCHES_PER_MINUTE = 20;
export const MAX_CONCURRENT_DOWNLOADS = 8;

/** The types Sylo serves: what the bytes of the file must show. */
const SIGNATURES = [
  [
    'image/png',
    (b) =>
      b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))],
  [
    'image/webp',
    (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
];
const ALLOWED_TYPES = new Set(SIGNATURES.map(([type]) => type));

/** The image type the first bytes show, or null. */
export function sniffImageType(buffer) {
  for (const [type, matches] of SIGNATURES) if (matches(buffer)) return type;
  return null;
}

let fetcher = safeFetch;
/** Tests only: replace the network fetch (called as fetcher(url, options)). */
export function _setImageFetcher(fn) {
  fetcher = fn ?? safeFetch;
}

/** @type {Map<string, { at: number, owner: string | null, type: string | null, body: Buffer | null }>} */
const cache = new Map();
/** owner -> { start, count }: downloads started in the current minute. */
const fetchWindows = new Map();
let running = 0;
/** @type {Map<string, Promise<{ type: string, body: Buffer } | null>>} */
const inflight = new Map();
let cachedBytes = 0;

/** Tests only. */
export function _clearImageCache() {
  cache.clear();
  inflight.clear();
  fetchWindows.clear();
  cachedBytes = 0;
}
/** Tests only: how much is held. */
export const _imageCacheSize = () => ({ entries: cache.size, bytes: cachedBytes });

const expired = (entry, now) => now - entry.at >= (entry.body ? OK_TTL_MS : FAILED_TTL_MS);

/** Drop every entry whose time is up, so its bytes leave the memory. */
export function sweepImageCache(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (!expired(entry, now)) continue;
    cachedBytes -= entry.body?.length ?? 0;
    cache.delete(key);
  }
  for (const [owner, w] of fetchWindows) if (now - w.start >= 60_000) fetchWindows.delete(owner);
}
every('events', SWEEP_MS, () => sweepImageCache());

/** What one owner holds. */
function usage(owner) {
  let entries = 0;
  let bytes = 0;
  for (const e of cache.values()) {
    if (e.owner !== owner) continue;
    entries += 1;
    bytes += e.body?.length ?? 0;
  }
  return { entries, bytes };
}

function evict(key) {
  cachedBytes -= cache.get(key)?.body?.length ?? 0;
  cache.delete(key);
}

/** The oldest entry of an owner other than `keep`, or undefined. */
function oldestOf(owner, keep) {
  for (const [key, e] of cache) if (e.owner === owner && key !== keep) return key;
  return undefined;
}

function remember(url, entry) {
  sweepImageCache();
  if (cache.has(url)) evict(url);
  cache.set(url, entry);
  cachedBytes += entry.body?.length ?? 0;
  // The owner's own share first: its oldest entries go (a Map keeps insertion order).
  for (;;) {
    const u = usage(entry.owner);
    if (u.entries <= MAX_OWNER_ENTRIES && u.bytes <= MAX_OWNER_BYTES) break;
    const victim = oldestOf(entry.owner, url);
    if (victim === undefined) break;
    evict(victim);
  }
  // Then the whole memory: the holder with the most of whatever limit was hit gives up its oldest
  // entry first. Too many entries: the one with the most entries (tiny images and remembered
  // failures count there). Too many bytes: the one with the most bytes. Ranking by bytes when it
  // is the entry limit that was hit would let tiny entries push out the one real image of another
  // server.
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_TOTAL_BYTES) {
    const byEntries = cache.size > MAX_ENTRIES;
    const held = new Map();
    for (const e of cache.values()) {
      const h = held.get(e.owner) ?? { bytes: 0, entries: 0 };
      h.bytes += e.body?.length ?? 0;
      h.entries += 1;
      held.set(e.owner, h);
    }
    const key = byEntries ? 'entries' : 'bytes';
    const other = byEntries ? 'bytes' : 'entries';
    const order = [...held].sort((x, y) => y[1][key] - x[1][key] || y[1][other] - x[1][other]);
    const victim = order.map(([owner]) => oldestOf(owner, url)).find((k) => k !== undefined);
    if (victim === undefined) break;
    evict(victim);
  }
}

/** May this owner start another download now? Counts it when yes. */
function mayDownload(owner) {
  if (running >= MAX_CONCURRENT_DOWNLOADS) return false;
  if (owner === null) return true;
  const now = Date.now();
  let w = fetchWindows.get(owner);
  if (!w || now - w.start >= 60_000) {
    w = { start: now, count: 0 };
    fetchWindows.set(owner, w);
  }
  if (w.count >= OWNER_FETCHES_PER_MINUTE) return false;
  w.count += 1;
  return true;
}

async function download(url) {
  try {
    const res = await fetcher(url, {
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
      maxRedirects: 0,
      allowPrivate: false,
      headers: { accept: [...ALLOWED_TYPES].join(', ') },
    });
    if (res.status !== 200 || !Buffer.isBuffer(res.body) || res.body.length === 0) return null;
    const declared = String(res.headers?.get?.('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_TYPES.has(declared)) return null;
    const type = sniffImageType(res.body);
    return type ? { type, body: res.body } : null;
  } catch {
    return null;
  }
}

/**
 * The image behind a link, or null when it may not be fetched or the fetch fails.
 * @param {unknown} link  an address from the event or the server, never from a visitor
 * @param {string | null} [owner]  the server the page belongs to: its share of the memory and
 *   its download budget (see the top of the file); null for none
 * @returns {Promise<{ type: string, body: Buffer } | null>}
 */
export async function loadImage(link, owner = null) {
  const url = trustedImageUrl(link);
  if (!url) return null;
  sweepImageCache();
  const hit = cache.get(url);
  if (hit) return hit.body ? { type: hit.type, body: hit.body } : null;
  if (inflight.has(url)) return inflight.get(url);
  if (!mayDownload(owner)) return null; // over the limits: no image now, and nothing is started
  running += 1;
  const pending = download(url)
    .then((image) => {
      remember(url, { at: Date.now(), owner, type: image?.type ?? null, body: image?.body ?? null });
      return image;
    })
    .finally(() => {
      running -= 1;
      inflight.delete(url);
    });
  inflight.set(url, pending);
  return pending;
}
