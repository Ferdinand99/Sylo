// Loads and validates environment configuration for Sylo.
// All secrets and tunables come from environment variables (see .env.example).
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

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

/** Read a boolean env var (1/true/yes/on = true). */
function optionalBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
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

// DISCORD_GUILD_ID accepts one id or a comma/space-separated list. Each listed
// guild gets slash commands registered instantly; an unset/empty value means
// global registration.
const discordGuildIds = (optionalOrNull('DISCORD_GUILD_ID') ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const badGuildIds = discordGuildIds.filter((id) => !/^\d{17,20}$/.test(id));
if (badGuildIds.length) {
  console.error(`[config] DISCORD_GUILD_ID has invalid id(s): ${badGuildIds.join(', ')}`);
  process.exit(1);
}

// Dashboard auth. When DISCORD_CLIENT_SECRET is set, the dashboard requires
// "Log in with Discord" and gates actions to guild admins. When unset, the
// dashboard runs in open mode (localhost / trusted LAN only).
const discordClientSecret = optionalOrNull('DISCORD_CLIENT_SECRET');
const turnstileSiteKey = optionalOrNull('TURNSTILE_SITE_KEY');
const turnstileSecretKey = optionalOrNull('TURNSTILE_SECRET_KEY');
const itadApiKey = optionalOrNull('ITAD_API_KEY');
// Signs session cookies and short-lived tokens (e.g. verification links), so it
// must always exist. When unset we generate one; that only matters for
// persistence when the dashboard login is enabled.
let sessionSecret = optionalOrNull('SESSION_SECRET');
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex');
  if (discordClientSecret) {
    console.warn(
      '[config] SESSION_SECRET is not set — generated a random one. ' +
        'Dashboard sessions will not survive a restart until you pin SESSION_SECRET.'
    );
  }
}

export const config = Object.freeze({
  // Discord
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // Optional: register slash commands to these guild(s) for instant availability
  // during development (one id, or a comma/space-separated list). When empty,
  // commands are registered globally (can take up to ~1 hour to propagate).
  discordGuildIds,
  discordGuildId: discordGuildIds[0] ?? null, // back-compat: first listed guild

  // Web dashboard
  webPort,
  // Public base URL of the dashboard, used to build the OAuth2 redirect URI.
  // When null it is derived per-request (fine for direct access; set this
  // behind a reverse proxy).
  dashboardUrl: optionalOrNull('DASHBOARD_URL')?.replace(/\/+$/, '') ?? null,

  // Dashboard auth (see above)
  authEnabled: Boolean(discordClientSecret),
  discordClientSecret,
  sessionSecret,

  // Cloudflare Turnstile — powers the Verification module's captcha mode. When
  // both are unset, captcha mode falls back to a plain button.
  turnstileSiteKey,
  turnstileSecretKey,
  turnstileEnabled: Boolean(turnstileSiteKey && turnstileSecretKey),

  // IsThereAnyDeal API key — broadens the Free games module beyond Epic. Free
  // key from isthereanydeal.com/apps. When unset, Free games is Epic-only.
  itadApiKey,
  itadEnabled: Boolean(itadApiKey),

  // Game stats
  gametoolsApiBase: optional('GAMETOOLS_API_BASE', 'https://api.gametools.network').replace(/\/+$/, ''),
  cacheTtlMinutes,
  cacheTtlMs: cacheTtlMinutes * 60 * 1000,

  // Persistence
  databasePath: optional('DATABASE_PATH', './data/sylo.db'),

  // Privileged gateway intents. Enable the matching toggles in the Discord
  // Developer Portal (Bot page). Verified bots may also need Discord's approval.
  // Turn a flag off to boot without that intent (dependent modules then stay
  // disabled) rather than hitting a "disallowed intents" login error.
  intentGuildMembers: optionalBool('INTENT_GUILD_MEMBERS', true),
  intentMessageContent: optionalBool('INTENT_MESSAGE_CONTENT', true),

  // Misc
  nodeEnv: optional('NODE_ENV', 'development'),
});
