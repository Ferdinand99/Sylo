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
// MAX_TOTAL_BYTES of image data, oldest out first; a failure is remembered for a shorter time.
import { safeFetch } from '../../lib/safeFetch.js';
import { trustedImageUrl } from './eventPage.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 5000;
export const OK_TTL_MS = 10 * 60_000;
export const FAILED_TTL_MS = 60_000;
export const MAX_ENTRIES = 64;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

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

/** @type {Map<string, { at: number, type: string | null, body: Buffer | null }>} */
const cache = new Map();
/** @type {Map<string, Promise<{ type: string, body: Buffer } | null>>} */
const inflight = new Map();
let cachedBytes = 0;

/** Tests only. */
export function _clearImageCache() {
  cache.clear();
  inflight.clear();
  cachedBytes = 0;
}
/** Tests only: how much is held. */
export const _imageCacheSize = () => ({ entries: cache.size, bytes: cachedBytes });

function remember(url, entry) {
  const old = cache.get(url);
  if (old) {
    cachedBytes -= old.body?.length ?? 0;
    cache.delete(url);
  }
  cache.set(url, entry);
  cachedBytes += entry.body?.length ?? 0;
  // Oldest out first (a Map keeps insertion order) until both bounds hold.
  for (const key of cache.keys()) {
    if (cache.size <= MAX_ENTRIES && cachedBytes <= MAX_TOTAL_BYTES) break;
    if (key === url) continue;
    cachedBytes -= cache.get(key).body?.length ?? 0;
    cache.delete(key);
  }
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
 * @returns {Promise<{ type: string, body: Buffer } | null>}
 */
export async function loadImage(link) {
  const url = trustedImageUrl(link);
  if (!url) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.body ? OK_TTL_MS : FAILED_TTL_MS)) {
    return hit.body ? { type: hit.type, body: hit.body } : null;
  }
  if (inflight.has(url)) return inflight.get(url);
  const pending = download(url)
    .then((image) => {
      remember(url, { at: Date.now(), type: image?.type ?? null, body: image?.body ?? null });
      return image;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, pending);
  return pending;
}
