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
