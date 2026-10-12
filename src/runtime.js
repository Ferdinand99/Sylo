// Shared, in-memory runtime state for a single Sylo process.
// The bot writes to it; the web dashboard and /health endpoint read from it.
// Keeping this tiny and framework-free avoids a circular dependency between
// the bot and web modules.

/**
 * @typedef {Object} ErrorEntry
 * @property {string} message
 * @property {string|null} scope
 * @property {number} at             Epoch ms.
 * @property {string|null} stack
 */

/**
 * @typedef {Object} RuntimeState
 * @property {number} startedAt          Epoch ms when the process booted.
 * @property {{ message: string, at: number } | null} lastError  Most recent unexpected error.
 * @property {ErrorEntry[]} errors       Recent errors, most-recent-first, capped.
 * @property {{ discord: import('discord.js').Client | null, fluxer: object | null }} clients
 *   One logged-in client per platform, keyed by platform name. Either side is
 *   null until that platform is configured and connected.
 */

const MAX_ERRORS = 40;
// One gateway-ping sample a minute (see src/bot/events/ready.js) — an hour of
// history for the /health sparkline.
const MAX_PING_SAMPLES = 60;

/** @type {RuntimeState} */
export const runtime = {
  startedAt: Date.now(),
  lastError: null,
  errors: [],
  /** @type {number[]} Gateway ping in ms, oldest first, capped. */
  pingHistory: [],
  clients: { discord: null, fluxer: null },
  // Back-compat alias for the (still overwhelmingly common) Discord-only call
  // sites, and for the test suite's existing `runtime.client = fake` direct
  // assignments — both reads and writes transparently go through to
  // `clients.discord` instead of a second, separate source of truth.
  get client() {
    return this.clients.discord;
  },
  set client(value) {
    this.clients.discord = value;
  },
};

/**
 * Record an unexpected error so it can be surfaced on the /health page.
 * @param {unknown} err
 * @param {string|null} [scope]
 */
export function recordError(err, scope = null) {
  const message = err instanceof Error ? err.message : String(err);
  const at = Date.now();
  runtime.lastError = { message, at };
  runtime.errors.unshift({
    message,
    scope: scope || null,
    at,
    stack: err instanceof Error ? (err.stack ?? null) : null,
  });
  if (runtime.errors.length > MAX_ERRORS) runtime.errors.length = MAX_ERRORS;
}

/** Back-compat alias for earlier call sites. */
export const setLastError = recordError;

/**
 * Count the errors currently in the ring buffer, grouped by scope.
 * @returns {Record<string, number>}
 */
export function errorScopeCounts() {
  const out = {};
  for (const e of runtime.errors) {
    const key = e.scope || 'unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Record a gateway-ping sample for the /health history. Ignores the -1 discord.js
 * reports before the first heartbeat.
 * @param {number} ms
 */
export function recordGatewayPing(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
  runtime.pingHistory.push(Math.round(ms));
  if (runtime.pingHistory.length > MAX_PING_SAMPLES) runtime.pingHistory.shift();
}

/**
 * Attach a logged-in client for a platform.
 * @param {'discord'|'fluxer'} platform
 * @param {unknown} client
 */
export function setClientFor(platform, client) {
  runtime.clients[platform] = client;
}

/**
 * @param {'discord'|'fluxer'} platform
 * @returns {unknown}
 */
export function clientFor(platform) {
  return runtime.clients[platform] ?? null;
}

/**
 * Back-compat alias — attaches the Discord client specifically.
 * @param {import('discord.js').Client} client
 */
export function setClient(client) {
  setClientFor('discord', client);
}

const PLATFORM_ORDER = ['discord', 'fluxer'];

/** Uptime in whole seconds since process start. */
export function uptimeSeconds() {
  return Math.floor((Date.now() - runtime.startedAt) / 1000);
}

/** Whether the Discord client is connected and ready. */
export function isDiscordReady() {
  return Boolean(runtime.client?.isReady());
}

/** Number of guilds the bot is currently in (0 when not ready). */
export function guildCount() {
  return runtime.client?.guilds.cache.size ?? 0;
}

/** One entry per connected platform, for the health views. */
export function platformStatus() {
  return PLATFORM_ORDER.filter((p) => runtime.clients[p]).map((platform) => {
    const client = runtime.clients[platform];
    return {
      platform,
      ready: Boolean(client.isReady?.()),
      guilds: client.guilds?.cache?.size ?? 0,
      tag: client.user?.tag ?? null,
    };
  });
}

/** Guilds across every connected platform. */
export function totalGuildCount() {
  return platformStatus().reduce((sum, p) => sum + p.guilds, 0);
}

/** Is at least one connected platform ready? */
export function isAnyClientReady() {
  return platformStatus().some((p) => p.ready);
}
