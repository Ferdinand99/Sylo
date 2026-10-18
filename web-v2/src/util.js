export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const LAST_GUILD_KEY = 'sylo:v2:lastGuildId';

/** Best-effort read/write — private browsing or blocked storage just no-ops. */
export function readLastGuildId() {
  try {
    return localStorage.getItem(LAST_GUILD_KEY);
  } catch {
    return null;
  }
}

export function writeLastGuildId(guildId) {
  try {
    localStorage.setItem(LAST_GUILD_KEY, guildId);
  } catch {
    // ignore — nothing to fall back to, this is just a convenience
  }
}

const THEME_KEY = 'sylo:v2:theme';

/** 'light' or 'dark' — null means "no explicit choice yet", so the default applies. */
export function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function writeTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore — nothing to fall back to, this is just a convenience
  }
}

// Same key V1's header partial uses — dismissing an announcement in one
// dashboard dismisses it in the other too, since it's the same browser.
const DISMISSED_ANNOUNCEMENT_KEY = 'sylo:dismissedAnnouncement';

export function readDismissedAnnouncement() {
  try {
    return localStorage.getItem(DISMISSED_ANNOUNCEMENT_KEY);
  } catch {
    return null;
  }
}

export function writeDismissedAnnouncement(createdAt) {
  try {
    localStorage.setItem(DISMISSED_ANNOUNCEMENT_KEY, String(createdAt));
  } catch {
    // ignore — nothing to fall back to, this is just a convenience
  }
}

const RECENT_COLORS_KEY = 'sylo:v2:recentEmbedColors';
const MAX_RECENT_COLORS = 8;

/** Most-recently-used embed colours first, for the "History" row in ColorPicker. */
export function readRecentColors() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function addRecentColor(color) {
  try {
    const next = [color, ...readRecentColors().filter((c) => c !== color)].slice(0, MAX_RECENT_COLORS);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
  } catch {
    // ignore — nothing to fall back to, this is just a convenience
  }
}

// Intl.Segmenter splits on grapheme clusters, so a flag, a skin-toned emoji or
// an accented letter built from two code points stays one "character". Built
// lazily — older browsers without it fall back to code points below.
let segmenter;
function firstGrapheme(text) {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (segmenter) {
    const first = segmenter.segment(text)[Symbol.iterator]().next();
    return first.done ? '' : first.value.segment;
  }
  return [...text][0] ?? '';
}

/**
 * The placeholder letter shown in place of a missing server/bot icon:
 * the name's first visible character, uppercased. Unlike `name.charAt(0)`
 * this keeps an emoji-first name ("🎮 Gaming Hub") whole instead of
 * cutting a surrogate pair in half and rendering "�". '?' for no name.
 */
export function initial(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  return firstGrapheme(text).toUpperCase();
}

/**
 * A count for display: thousands separators in the viewer's locale
 * ("1,284"), and '—' when the value is missing instead of "undefined"/"NaN".
 * Non-number values (an already-formatted string) pass through unchanged.
 */
export function formatCount(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return value;
  return Number.isFinite(value) ? value.toLocaleString() : '—';
}
