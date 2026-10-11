// Composite guild-id convention: every guild id in application code is
// "<platform>:<raw id>" (e.g. "discord:123456789012345678"), not a bare
// snowflake — so a single opaque guildId string can be routed to the right
// platform's client (src/runtime.js) without any DB schema change. See the
// architecture plan (docs/superpowers/plans — Fluxer dual-platform support)
// for the full rationale.
export const PLATFORMS = ['discord', 'fluxer'];

/**
 * @param {'discord'|'fluxer'} platform
 * @param {string} rawId
 * @returns {string}
 */
export function makePlatformGuildId(platform, rawId) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  return `${platform}:${rawId}`;
}

/**
 * @param {unknown} value
 * @returns {{ platform: 'discord'|'fluxer', rawId: string } | null}
 */
export function splitPlatformGuildId(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(':');
  if (i === -1) return null;
  const platform = value.slice(0, i);
  const rawId = value.slice(i + 1);
  if (!PLATFORMS.includes(platform) || !rawId) return null;
  return { platform, rawId };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlatformGuildId(value) {
  return splitPlatformGuildId(value) !== null;
}
