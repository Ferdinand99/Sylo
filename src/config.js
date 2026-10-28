// Loads and validates environment configuration for Sylo.
// All secrets and tunables come from environment variables (see .env.example).
import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { resolveSessionSecret } from './lib/sessionSecret.js';
import { normalisePrivateKey } from './lib/appStoreConnect.js';

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
// Optional passphrase: off-site copies leave encrypted (src/lib/backupCrypto.js).
const backupEncryptionKey = optionalOrNull('BACKUP_ENCRYPTION_KEY');
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

// Hosted-only, opt-in Postgres driver (see docs/roadmap.md — "Postgres
// migration line"). Unset (the default) — and every self-hosted deployment —
// keeps today's SQLite path untouched. Currently READ-ONLY: nothing in
// src/db/ consults it yet; that lands in a follow-up PR.
const databaseUrl = optionalOrNull('DATABASE_URL');
if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  console.error('[config] DATABASE_URL must start with postgres:// or postgresql://.');
  process.exit(1);
}

// Dashboard auth. When a platform's client secret is set (DISCORD_CLIENT_SECRET /
// FLUXER_CLIENT_SECRET) the dashboard requires "Log in with <platform>" and gates
// actions to guild admins; with both set an account can hold both identities. When
// neither is set the dashboard runs in open mode (localhost / trusted LAN only).
const discordClientSecret = optionalOrNull('DISCORD_CLIENT_SECRET');
const fluxerClientSecret = optionalOrNull('FLUXER_CLIENT_SECRET');

/** A comma/space-separated list of user ids from the environment, validated. */
function idList(name) {
  const ids = (optionalOrNull(name) ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = ids.filter((id) => !/^\d{17,20}$/.test(id));
  if (bad.length) {
    console.error(`[config] ${name} has invalid id(s): ${bad.join(', ')}`);
    process.exit(1);
  }
  return ids;
}

// Bot-wide operator ids, per platform (a Discord user id and a Fluxer user id are
// different numbers). Gates /health — status, error log and database backup/restore
// across every server — to just these accounts, instead of any signed-in dashboard
// user. An account is an operator when any identity it holds is on its platform's list.
const ownerIds = idList('OWNER_IDS');
const fluxerOwnerIds = idList('FLUXER_OWNER_IDS');
// Channel Sylo posts its own operational errors to (a "dev-log", distinct from
// any per-guild logging/modlog channel a server admin configures — this is
// Sylo's own health signal, not moderation activity). Optional; unset means
// no proactive notification, matching every other opt-in integration here.
const devLogChannelId = optionalOrNull('DEV_LOG_CHANNEL_ID');
if (devLogChannelId && !/^\d{17,20}$/.test(devLogChannelId)) {
  console.error('[config] DEV_LOG_CHANNEL_ID must be a Discord channel id.');
  process.exit(1);
}
const turnstileSiteKey = optionalOrNull('TURNSTILE_SITE_KEY');
const turnstileSecretKey = optionalOrNull('TURNSTILE_SECRET_KEY');

// Error reports from the bot and the dashboard's pages, and the dashboard's visit counts, for
// the hosted Sylo. Each is off unless its DSN is set; see src/lib/errorReports.js and
// src/web/lib/telemetry.js.
const botErrorDsn = optionalOrNull('BOT_ERROR_DSN');
const dashboardErrorDsn = optionalOrNull('DASHBOARD_ERROR_DSN');
const dashboardVisitStats = optionalBool('DASHBOARD_VISIT_STATS', false);
const errorEnvironment = optionalOrNull('ERROR_ENVIRONMENT') ?? 'production';
const itadApiKey = optionalOrNull('ITAD_API_KEY');
const twitchClientId = optionalOrNull('TWITCH_CLIENT_ID');
const twitchClientSecret = optionalOrNull('TWITCH_CLIENT_SECRET');
const kickClientId = optionalOrNull('KICK_CLIENT_ID');
// App Store Connect alerts (owner-only module). An API key (.p8) from App Store Connect ->
// Users and Access -> Integrations. A team key also has an issuer id; an individual key has none.
const appleKeyId = optionalOrNull('APPLE_KEY_ID');
const appleIssuerId = optionalOrNull('APPLE_ISSUER_ID');
const applePrivateKey = normalisePrivateKey(process.env.APPLE_PRIVATE_KEY);
if (optionalOrNull('APPLE_PRIVATE_KEY') && !applePrivateKey) {
  console.error('[config] APPLE_PRIVATE_KEY is not a valid private key (PEM, "\\n"-escaped PEM or base64).');
}
const appleVendorNumber = optionalOrNull('APPLE_VENDOR_NUMBER');
// Push notifications for the Sylo app (internal/push-notifications-plan.md). Only the holder of
// the app's APNs key can talk to Apple: the hosted Sylo sets APNS_* and also relays for
// self-hosted instances, which send through PUSH_RELAY_URL (unset = the hosted Sylo, set but
// empty = no push).
/**
 * DASHBOARD_URL in its canonical form: lowercase host, no default port, no query, fragment or
 * trailing slash. It is the instance's address for the push relay, which compares it exactly.
 * @returns {string|null}
 */
export function normaliseDashboardUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    console.error('[config] DASHBOARD_URL is not a valid URL; ignoring it.');
    return null;
  }
}

const apnsKeyId = optionalOrNull('APNS_KEY_ID');
const apnsTeamId = optionalOrNull('APNS_TEAM_ID');
const apnsPrivateKey = normalisePrivateKey(process.env.APNS_PRIVATE_KEY);
if (optionalOrNull('APNS_PRIVATE_KEY') && !apnsPrivateKey) {
  console.error('[config] APNS_PRIVATE_KEY is not a valid private key (PEM, "\\n"-escaped PEM or base64).');
}
const apnsTopic = optional('APNS_TOPIC', 'net.opland.sylo');
let pushRelayUrl =
  process.env.PUSH_RELAY_URL === undefined
    ? 'https://app.sylobot.com'
    : process.env.PUSH_RELAY_URL.trim().replace(/\/+$/, '') || null;
if (pushRelayUrl && !/^https?:\/\/[^\s/]+[^\s]*$/i.test(pushRelayUrl)) {
  console.error('[config] PUSH_RELAY_URL must be an http(s) URL; push through the relay is off.');
  pushRelayUrl = null;
}
const kickClientSecret = optionalOrNull('KICK_CLIENT_SECRET');
// Signs session cookies and short-lived tokens (e.g. verification links), so it
// must always exist. SESSION_SECRET wins; otherwise a generated secret is kept in
// <data folder>/session-secret so sessions and signed links survive a restart.
// The data folder is the SQLite DATABASE_PATH folder (it also holds the backups),
// whether or not Postgres is used. Test runs never write a file (they would drop
// it into the repo's data/ folder).
const underTestRunner = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
const { secret: sessionSecret, source: sessionSecretSource } = resolveSessionSecret({
  envValue: optionalOrNull('SESSION_SECRET'),
  dataDir: underTestRunner
    ? null
    : dirname(resolve(process.cwd(), optional('DATABASE_PATH', './data/sylo.db'))),
  warn: (message) => console.warn(`[config] ${message}`),
});

// Platforms. Each one is optional, but at least one must be configured: a
// Discord-only install sets DISCORD_TOKEN, a Fluxer-only one FLUXER_TOKEN, and
// setting both runs Sylo on both from this one process.
const fluxerToken = optionalOrNull('FLUXER_TOKEN');
const discordToken = optionalOrNull('DISCORD_TOKEN') ?? (fluxerToken ? null : required('DISCORD_TOKEN'));
const discordClientId = discordToken ? required('DISCORD_CLIENT_ID') : null;
const fluxerClientId = fluxerToken ? required('FLUXER_CLIENT_ID') : null;

// Which Fluxer instance to talk to. Unset = hosted Fluxer (fluxer.app). For a
// self-hosted instance set FLUXER_WEB_URL (its web app origin, e.g.
// https://chat.example.com); the API, gateway and CDN hosts are read from its
// /.well-known/fluxer. FLUXER_API_URL overrides the API origin only.
const fluxerWebUrl = optionalOrNull('FLUXER_WEB_URL')?.replace(/\/+$/, '') ?? null;
const fluxerApiUrl = optionalOrNull('FLUXER_API_URL')?.replace(/\/+$/, '') ?? null;

// Fluxer has no slash commands yet, so commands run from chat as <prefix>name.
const commandPrefix = optional('COMMAND_PREFIX', '!');
if (/\s/.test(commandPrefix) || commandPrefix.length > 5) {
  console.error('[config] COMMAND_PREFIX must be 1-5 characters with no spaces.');
  process.exit(1);
}

export const config = Object.freeze({
  // Discord (null when this install does not run on Discord)
  discordToken,
  discordClientId,
  discordEnabled: Boolean(discordToken),
  // Fluxer (null when this install does not run on Fluxer)
  fluxerToken,
  fluxerClientId,
  fluxerEnabled: Boolean(fluxerToken),
  fluxerWebUrl,
  fluxerApiUrl,
  commandPrefix,
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
  dashboardUrl: normaliseDashboardUrl(process.env.DASHBOARD_URL),

  // Dashboard auth (see above)
  // "Log in with …" is offered for a platform only when it is configured to run and has an OAuth secret.
  discordAuthEnabled: Boolean(discordClientSecret && discordClientId),
  fluxerAuthEnabled: Boolean(fluxerClientSecret && fluxerClientId),
  authEnabled:
    Boolean(discordClientSecret && discordClientId) || Boolean(fluxerClientSecret && fluxerClientId),
  discordClientSecret,
  fluxerClientSecret,
  sessionSecret,
  sessionSecretSource,
  ownerIds,
  fluxerOwnerIds,
  devLogChannelId,

  // Cloudflare Turnstile — powers the Verification module's captcha mode. When
  // both are unset, captcha mode falls back to a plain button.
  turnstileSiteKey,
  turnstileSecretKey,
  turnstileEnabled: Boolean(turnstileSiteKey && turnstileSecretKey),

  // Error reports (any Sentry-compatible DSN, e.g. Keen Kestrel) from the bot and the
  // dashboard and, with DASHBOARD_VISIT_STATS, the dashboard's cookieless visit counts through
  // Keen Kestrel's k.js. Off when unset.
  botErrorDsn,
  dashboardErrorDsn,
  dashboardVisitStats,
  errorEnvironment,

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
  appleKeyId,
  appleIssuerId,
  applePrivateKey,
  appleVendorNumber,
  appleEnabled: Boolean(appleKeyId && applePrivateKey),

  // Push notifications (see above). apnsEnabled: this instance talks to Apple itself and serves
  // the relay; otherwise it can push through pushRelayUrl when that is set.
  apnsKeyId,
  apnsTeamId,
  apnsPrivateKey,
  apnsTopic,
  apnsEnabled: Boolean(apnsKeyId && apnsTeamId && apnsPrivateKey),
  pushRelayUrl,
  // URLs that server admins type in (RSS feeds, the welcome card background) are fetched by
  // the server, so private, loopback and link-local addresses are refused (src/lib/safeFetch.js).
  // A self-hosted instance that wants feeds from its own network can allow them.
  // Which proxies may set X-Forwarded-For (see trustProxySetting in src/web/server.js).
  trustProxy: optionalOrNull('TRUST_PROXY'),
  allowPrivateUrls: /^(1|true|yes|on)$/i.test(process.env.ALLOW_PRIVATE_URLS ?? ''),

  // Game stats
  gametoolsApiBase: optional('GAMETOOLS_API_BASE', 'https://api.gametools.network').replace(/\/+$/, ''),
  cacheTtlMinutes,
  cacheTtlMs: cacheTtlMinutes * 60 * 1000,

  // Persistence
  databasePath: optional('DATABASE_PATH', './data/sylo.db'),
  databaseUrl,
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
  backupEncryptionKey,

  // Privileged gateway intents. Enable the matching toggles in the Discord
  // Developer Portal (Bot page). Verified bots may also need Discord's approval.
  // Turn a flag off to boot without that intent (dependent modules then stay
  // disabled) rather than hitting a "disallowed intents" login error.
  intentGuildMembers: optionalBool('INTENT_GUILD_MEMBERS', true),
  intentMessageContent: optionalBool('INTENT_MESSAGE_CONTENT', true),

  // Misc
  nodeEnv: optional('NODE_ENV', 'development'),
});
