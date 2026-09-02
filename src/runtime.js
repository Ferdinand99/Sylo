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
 * @property {import('discord.js').Client | null} client  The logged-in Discord client, once ready.
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
  client: null,
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
 * Attach the Discord client once it has logged in.
 * @param {import('discord.js').Client} client
 */
export function setClient(client) {
  runtime.client = client;
}

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
