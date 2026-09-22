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
