// Shared, in-memory runtime state for a single Sylo process.
// The bot writes to it; the web dashboard and /health endpoint read from it.
// Keeping this tiny and framework-free avoids a circular dependency between
// the bot and web modules.

/**
 * @typedef {Object} RuntimeState
 * @property {number} startedAt          Epoch ms when the process booted.
 * @property {{ message: string, at: number } | null} lastError  Most recent unexpected error.
 * @property {import('discord.js').Client | null} client  The logged-in Discord client, once ready.
 */

/** @type {RuntimeState} */
export const runtime = {
  startedAt: Date.now(),
  lastError: null,
  client: null,
};

/**
 * Record the most recent unexpected error so it can be surfaced on the dashboard.
 * @param {unknown} err
 */
export function setLastError(err) {
  const message = err instanceof Error ? err.message : String(err);
  runtime.lastError = { message, at: Date.now() };
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
