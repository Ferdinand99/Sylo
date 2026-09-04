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

// Automatic database backups: compacted single-file snapshots written via
// SQLite "VACUUM INTO" to BACKUP_DIR (default <db dir>/backups). A snapshot is
// also taken automatically just before any schema migration. Set the interval
// to 0 to turn off the scheduled backup (pre-migration + manual still run).
const backupIntervalHours = Number(optional('BACKUP_INTERVAL_HOURS', '24'));
if (!Number.isFinite(backupIntervalHours) || backupIntervalHours < 0) {
  console.error('[config] BACKUP_INTERVAL_HOURS must be 0 or a positive number.');
  process.exit(1);
}
const backupRetention = Number(optional('BACKUP_RETENTION', '14'));
if (!Number.isInteger(backupRetention) || backupRetention < 1) {
  console.error('[config] BACKUP_RETENTION must be a whole number of 1 or more.');
  process.exit(1);
}

// Off-site backup targets (optional). After every local snapshot a gzipped copy
// is shipped to whichever of these is set. Both are best-effort.
const backupWebdavUrl = optionalOrNull('BACKUP_WEBDAV_URL');
const backupWebdavUser = optionalOrNull('BACKUP_WEBDAV_USER');
const backupWebdavPass = optionalOrNull('BACKUP_WEBDAV_PASS');
const backupWebhookUrl = optionalOrNull('BACKUP_WEBHOOK_URL');
if (backupWebhookUrl && !/^https:\/\//i.test(backupWebhookUrl)) {
  console.warn('[config] BACKUP_WEBHOOK_URL should be an https Discord webhook URL.');
}

// DISCORD_DEV_GUILD_IDS: one id or a comma/space-separated list of servers that
// get slash commands registered instantly (a dev convenience). Empty = global
// registration. DISCORD_GUILD_ID is the pre-3.0 name — still honoured, with a
// warning.
const legacyGuildId = optionalOrNull('DISCORD_GUILD_ID');
if (legacyGuildId) {
  console.warn('[config] DISCORD_GUILD_ID is deprecated — rename it to DISCORD_DEV_GUILD_IDS.');
}
const discordGuildIds = (optionalOrNull('DISCORD_DEV_GUILD_IDS') ?? legacyGuildId ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const badGuildIds = discordGuildIds.filter((id) => !/^\d{17,20}$/.test(id));
if (badGuildIds.length) {
  console.error(`[config] DISCORD_DEV_GUILD_IDS has invalid id(s): ${badGuildIds.join(', ')}`);
  process.exit(1);
}

// Internal sharding: how many gateway shards this single process runs. 'auto'
// (the default) asks Discord for the recommended count — it stays 1 until the
// bot is in ~2,500+ servers, so it is a no-op for small instances. A positive
// integer pins the count. This is always one process; multi-process sharding is
// not supported.
const shardCountRaw = optional('DISCORD_SHARD_COUNT', 'auto').toLowerCase();
let discordShardCount = 'auto';
if (shardCountRaw !== 'auto') {
  discordShardCount = Number(shardCountRaw);
  if (!Number.isInteger(discordShardCount) || discordShardCount < 1) {
    console.error("[config] DISCORD_SHARD_COUNT must be 'auto' or a positive integer.");
    process.exit(1);
  }
}

// Dashboard auth. When DISCORD_CLIENT_SECRET is set, the dashboard requires
// "Log in with Discord" and gates actions to guild admins. When unset, the
// dashboard runs in open mode (localhost / trusted LAN only).
const discordClientSecret = optionalOrNull('DISCORD_CLIENT_SECRET');
// Bot-wide operator ids (comma/space-separated Discord user ids). Gates /health
// — status, error log and database backup/restore across every server — to just
// these accounts, instead of any signed-in dashboard user.
const ownerIds = (optionalOrNull('OWNER_IDS') ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const badOwnerIds = ownerIds.filter((id) => !/^\d{17,20}$/.test(id));
if (badOwnerIds.length) {
  console.error(`[config] OWNER_IDS has invalid id(s): ${badOwnerIds.join(', ')}`);
  process.exit(1);
}
const turnstileSiteKey = optionalOrNull('TURNSTILE_SITE_KEY');
const turnstileSecretKey = optionalOrNull('TURNSTILE_SECRET_KEY');
const itadApiKey = optionalOrNull('ITAD_API_KEY');
const twitchClientId = optionalOrNull('TWITCH_CLIENT_ID');
const twitchClientSecret = optionalOrNull('TWITCH_CLIENT_SECRET');
const kickClientId = optionalOrNull('KICK_CLIENT_ID');
const kickClientSecret = optionalOrNull('KICK_CLIENT_SECRET');
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
  // Internal gateway sharding for this one process. 'auto' | positive integer.
  discordShardCount,

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
  ownerIds,

  // Cloudflare Turnstile — powers the Verification module's captcha mode. When
  // both are unset, captcha mode falls back to a plain button.
  turnstileSiteKey,
  turnstileSecretKey,
  turnstileEnabled: Boolean(turnstileSiteKey && turnstileSecretKey),

  // IsThereAnyDeal API key — broadens the Free games module beyond Epic. Free
  // key from isthereanydeal.com/apps. When unset, Free games is Epic-only.
  itadApiKey,
  itadEnabled: Boolean(itadApiKey),

  // Twitch API app credentials — power the Twitch alerts module. Free app at
  // dev.twitch.tv/console. When unset, the module's poll loop no-ops.
  twitchClientId,
  twitchClientSecret,
  twitchEnabled: Boolean(twitchClientId && twitchClientSecret),

  // Kick API app credentials — power the Kick alerts module. Free app under
  // kick.com/settings/developer. When unset, the module's poll loop no-ops.
  kickClientId,
  kickClientSecret,
  kickEnabled: Boolean(kickClientId && kickClientSecret),

  // Game stats
  gametoolsApiBase: optional('GAMETOOLS_API_BASE', 'https://api.gametools.network').replace(/\/+$/, ''),
  cacheTtlMinutes,
  cacheTtlMs: cacheTtlMinutes * 60 * 1000,

  // Persistence
  databasePath: optional('DATABASE_PATH', './data/sylo.db'),
  // Database backups. backupDir null => <db dir>/backups. intervalHours 0 =>
  // scheduled backup off. retention = how many snapshots to keep.
  backupDir: optionalOrNull('BACKUP_DIR'),
  backupIntervalHours,
  backupRetention,
  // Off-site backup targets. Any/all/none; a gzipped copy of each snapshot is
  // pushed to whatever is set (best-effort, logged).
  backupWebdavUrl,
  backupWebdavUser,
  backupWebdavPass,
  backupWebhookUrl,

  // Privileged gateway intents. Enable the matching toggles in the Discord
  // Developer Portal (Bot page). Verified bots may also need Discord's approval.
  // Turn a flag off to boot without that intent (dependent modules then stay
  // disabled) rather than hitting a "disallowed intents" login error.
  intentGuildMembers: optionalBool('INTENT_GUILD_MEMBERS', true),
  intentMessageContent: optionalBool('INTENT_MESSAGE_CONTENT', true),

  // Misc
  nodeEnv: optional('NODE_ENV', 'development'),
});
