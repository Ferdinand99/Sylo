// A server's look on its public member pages, put together for the pages and for the dashboard: what the chosen
// accent and background come to (the accent where it is readable, the picture that is really there), the
// address of the style sheet a page loads, and the one place the invite splash is fetched.
//
// Nothing is hotlinked: a background is a picture Sylo stores (an upload, or a copy of the server's invite splash
// that Sylo downloaded itself) and serves from its own address (routes/publicLook.js), so a visitor's browser
// never talks to the platform's CDN and the CSP can keep images to this site.
import { log } from '../../lib/log.js';
import { safeFetch } from '../../lib/safeFetch.js';
import { MAX_UPLOAD_BYTES, ImageError, processImage } from '../../lib/collectibleImage.js';
import {
  BACKGROUND_MAX_SIDE,
  BACKGROUND_QUALITY,
  deleteLookImage,
  getLookImageMeta,
  getPublicLook,
  putLookImage,
  touchLookImage,
} from '../../db/publicLook.js';
import {
  BACKGROUNDS,
  SYLO_ACCENT,
  accentCheck,
  effectiveAccent,
  fallbackNote,
  imageHashOf,
  lookCss,
  lookHash,
  slugOf,
} from '../../lib/publicLook.js';
import { guildByKey, platformOfGuild } from '../../platform/platformOf.js';

/** A copied splash is checked against the platform once a day. */
export const SPLASH_REFRESH_MS = 24 * 60 * 60 * 1000;
/** After a failed download, wait this long before trying again (a page view starts a try). */
const SPLASH_RETRY_MS = 15 * 60 * 1000;
/** The size asked for at the platform's CDN: a power of two, enough for a full-page background. */
const SPLASH_SIZE = 2048;

/** The address of a stored picture: guild-scoped and named by its content hash. */
export const imagePath = (key, hash) => `/look/${slugOf(key)}.${hash}.webp`;
/** The address of a server's look style sheet. */
export const cssPath = (key, hash) => `/look/${slugOf(key)}.${hash}.css`;

/**
 * The picture a server's background really is: the one it chose, if that source has a picture.
 * @returns {Promise<{ source: 'upload' | 'splash', hash: string } | null>}
 */
async function activeImage(key, background) {
  const source = background === 'upload' ? 'upload' : background === 'discord-splash' ? 'splash' : null;
  if (!source) return null;
  const meta = await getLookImageMeta(key, source);
  return meta ? { source, hash: meta.hash } : null;
}

/**
 * The look a page of this server takes: the style sheet to load, or null when the server chose nothing (the
 * page stays plain Sylo). With a splash background it also starts the daily check, without waiting for it.
 * @param {string} key  the server key
 * @returns {Promise<{ css: string, accent: string, imageUrl: string | null } | null>}
 */
export async function lookFor(key) {
  if (!key) return null;
  let row;
  try {
    row = await getPublicLook(key);
  } catch (err) {
    // A look is decoration: a page never fails because of it.
    log.warn('public-look', 'could not read the look of a server:', err.message);
    return null;
  }
  if (row.background === 'discord-splash') maybeRefreshSplash(key);
  const image = await activeImage(key, row.background).catch(() => null);
  if (!row.accent && !image) return null;
  const hash = lookHash({ accent: row.accent, imageHash: image?.hash });
  return {
    css: cssPath(key, hash),
    accent: row.accent,
    imageUrl: image ? imagePath(key, image.hash) : null,
  };
}

/**
 * The look for the dashboard's member pages (the shop, the application form), which are React pages that load the
 * style sheet themselves: its address and whether there is a background picture, or null for plain Sylo.
 * @returns {Promise<{ css: string, image: boolean } | null>}
 */
export async function lookRef(key) {
  const look = await lookFor(key);
  return look ? { css: look.css, image: look.imageUrl != null } : null;
}

/** The stored look as the style sheet of a request says it: for the route, by the hash in the address. */
export async function cssFor(key, hash) {
  const row = await getPublicLook(key);
  const image = await activeImage(key, row.background);
  if (!row.accent && !image) return null;
  if (lookHash({ accent: row.accent, imageHash: image?.hash }) !== hash) return null;
  return lookCss({ accent: row.accent, imageUrl: image ? imagePath(key, image.hash) : null });
}

// --- the invite splash -------------------------------------------------------------------------------------

/** What the platform says about the server's invite splash: its hash and where to fetch it. */
function splashOf(guild) {
  const hash = guild?.splash;
  if (!hash || typeof hash !== 'string') return null;
  // Discord takes an extension; Fluxer's helper ignores it. Both give a bounded size.
  const url = guild.splashURL?.({ size: SPLASH_SIZE, extension: 'webp' }) ?? null;
  return url ? { hash, url } : null;
}

/** Does the server have an invite splash right now? */
export const hasSplash = (guild) => splashOf(guild) != null;

const inFlight = new Map();
const lastFailure = new Map();

/** For tests: forget which servers failed a download lately. */
export const _resetSplashRetry = () => lastFailure.clear();

/**
 * Make sure the stored copy of the server's invite splash is the platform's current one. Downloads only when the
 * splash changed (or was never copied); a splash that is still the same is just marked as checked. A server
 * that no longer has one loses its copy. Never throws: the caller gets what happened.
 * @param {object} guild  the platform's guild object
 * @param {{ force?: boolean, now?: number, fetch?: typeof safeFetch }} [opts]
 *   `force` skips the once-a-day rule (a save or the "check now" button).
 * @returns {Promise<{ status: 'none' | 'unchanged' | 'updated' | 'failed', message?: string }>}
 */
export async function refreshSplash(guild, { force = false, now = Date.now(), fetch = safeFetch } = {}) {
  const key = guildKeyOfGuild(guild);
  const running = inFlight.get(key);
  if (running) return running;
  const job = doRefresh(guild, key, { force, now, fetch }).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

const guildKeyOfGuild = (guild) => {
  // The keyed id when the caller holds the dashboard's guild, else the platform's own id.
  const id = String(guild.id);
  return platformOfGuild(guild) === 'fluxer' && !id.startsWith('fluxer:') ? `fluxer:${id}` : id;
};

async function doRefresh(guild, key, { force, now, fetch }) {
  try {
    const known = await getLookImageMeta(key, 'splash');
    const splash = splashOf(guild);
    if (!splash) {
      if (known) await deleteLookImage(key, 'splash');
      return { status: 'none' };
    }
    if (known && known.origin === splash.hash) {
      if (force || now - known.checkedAt >= SPLASH_REFRESH_MS) await touchLookImage(key, 'splash', now);
      return { status: 'unchanged' };
    }
    if (!force && now - (lastFailure.get(key) ?? 0) < SPLASH_RETRY_MS) return { status: 'failed' };
    const res = await fetch(splash.url, { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`the platform answered ${res.status}`);
    const picture = await processImage(res.body, {
      owner: key,
      maxSide: BACKGROUND_MAX_SIDE,
      quality: BACKGROUND_QUALITY,
    });
    await putLookImage(key, 'splash', {
      hash: imageHashOf(picture.data),
      mime: picture.mime,
      data: picture.data,
      origin: splash.hash,
      now,
    });
    lastFailure.delete(key);
    return { status: 'updated' };
  } catch (err) {
    const message =
      err instanceof ImageError ? err.message : 'The invite background could not be downloaded.';
    lastFailure.set(key, now);
    log.warn('public-look', `invite splash of ${key} not refreshed: ${err.message}`);
    return { status: 'failed', message };
  }
}

/** A page view asks for a look of a splash server: refresh in the background when the copy is a day old. */
function maybeRefreshSplash(key) {
  const guild = guildByKey(key);
  if (!guild || inFlight.has(key)) return;
  getLookImageMeta(key, 'splash')
    .then((known) => {
      if (known && Date.now() - known.checkedAt < SPLASH_REFRESH_MS) return;
      return refreshSplash(guild);
    })
    .catch(() => {});
}

// --- the dashboard's view ---------------------------------------------------------------------------------

/** The settings page's data for a server: the choice, the pictures there are, and what it all comes to. */
export async function lookView(guild, key) {
  const [row, upload, splash] = await Promise.all([
    getPublicLook(key),
    getLookImageMeta(key, 'upload'),
    getLookImageMeta(key, 'splash'),
  ]);
  const platform = platformOfGuild(guild);
  const image = row.background === 'upload' ? upload : row.background === 'discord-splash' ? splash : null;
  const check = accentCheck(row.accent);
  const look = row.accent || image ? await lookFor(key) : null;
  return {
    platform,
    accent: row.accent,
    background: row.background,
    backgrounds: [...BACKGROUNDS],
    upload: upload
      ? { bytes: upload.bytes, url: imagePath(key, upload.hash), updatedAt: upload.createdAt }
      : null,
    splash: {
      // Both platforms have an invite splash; a server may simply not have set one.
      available: hasSplash(guild),
      copied: splash
        ? { url: imagePath(key, splash.hash), checkedAt: splash.checkedAt, updatedAt: splash.createdAt }
        : null,
    },
    effective: {
      accent: effectiveAccent(row.accent),
      contrast: { dark: check.dark, light: check.light },
      fallback: check.fallback,
      note: fallbackNote(row.accent),
      backgroundUrl: image ? imagePath(key, image.hash) : null,
      css: look?.css ?? null,
    },
    sylo: { accent: SYLO_ACCENT },
    limits: { maxBytes: MAX_UPLOAD_BYTES, types: ['PNG', 'JPEG', 'WebP'], maxSide: BACKGROUND_MAX_SIDE },
  };
}
