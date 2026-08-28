// Loads and validates environment configuration for Sylo.
// All secrets and tunables come from environment variables (see .env.example).
import 'dotenv/config';

/**
 * Read a required string env var, or exit with a clear message.
 * @param {string} name
 * @returns {string}
 */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(
      `[config] Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill in the values, or set it in your environment.`
    );
    process.exit(1);
  }
  return value.trim();
}

/**
 * Read an optional string env var with a fallback default.
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Read an optional string env var, or `null` when unset.
 * @param {string} name
 * @returns {string | null}
 */
function optionalOrNull(name) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : null;
}

const cacheTtlMinutes = Number(optional('STATS_CACHE_TTL_MINUTES', '5'));
if (!Number.isFinite(cacheTtlMinutes) || cacheTtlMinutes <= 0) {
  console.error('[config] STATS_CACHE_TTL_MINUTES must be a positive number.');
  process.exit(1);
}

const webPort = Number(optional('WEB_PORT', '3000'));
if (!Number.isInteger(webPort) || webPort <= 0 || webPort > 65535) {
  console.error('[config] WEB_PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

export const config = Object.freeze({
  // Discord
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // Optional: register slash commands to a single guild for instant availability during development.
  // When unset, commands are registered globally (can take up to ~1 hour to propagate).
  discordGuildId: optionalOrNull('DISCORD_GUILD_ID'),

  // Web dashboard
  webPort,

  // Game stats
  gametoolsApiBase: optional('GAMETOOLS_API_BASE', 'https://api.gametools.network').replace(/\/+$/, ''),
  cacheTtlMinutes,
  cacheTtlMs: cacheTtlMinutes * 60 * 1000,

  // Persistence
  databasePath: optional('DATABASE_PATH', './data/sylo.db'),

  // Misc
  nodeEnv: optional('NODE_ENV', 'development'),
});
