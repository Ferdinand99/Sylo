// Guild-id convention for running on more than one chat platform.
//
// A Discord guild id stays a bare snowflake ("123456789012345678") — exactly
// what it has always been, so every existing DB row, URL, signed token and
// guilds.cache lookup keeps working untouched. Any other platform's id carries
// a "<platform>:" prefix ("fluxer:987654321098765432"). Bare therefore always
// means Discord, and ids from different platforms can never collide.
export const PLATFORMS = ['discord', 'fluxer'];

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * @param {'discord'|'fluxer'} platform
 * @param {string} rawId
 * @returns {string}
 */
export function makePlatformGuildId(platform, rawId) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  return platform === 'discord' ? rawId : `${platform}:${rawId}`;
}

/**
 * @param {unknown} value
 * @returns {{ platform: 'discord'|'fluxer', rawId: string } | null}
 */
export function splitPlatformGuildId(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(':');
  if (i === -1) return SNOWFLAKE.test(value) ? { platform: 'discord', rawId: value } : null;
  const platform = value.slice(0, i);
  const rawId = value.slice(i + 1);
  // Discord ids are never prefixed, so "discord:<id>" is not a valid form.
  if (platform === 'discord' || !PLATFORMS.includes(platform) || !SNOWFLAKE.test(rawId)) return null;
  return { platform, rawId };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlatformGuildId(value) {
  return splitPlatformGuildId(value) !== null;
}
