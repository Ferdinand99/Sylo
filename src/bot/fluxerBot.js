// Fluxer client bootstrap: the counterpart of bot/index.js's startBot(). Build
// the client, put the component bridge on its send path, attach prefix
// commands and the reaction bridge, log in, and publish the client as
// runtime.clients.fluxer.
//
// The SDK is imported only here, and only when Fluxer is configured, so a
// Discord-only install never loads it.
import { config } from '../config.js';
import { setClientFor } from '../runtime.js';
import { log } from '../lib/log.js';
import { loadCommands } from './loadCommands.js';
import { attachPrefixCommands, isCommandMessage } from './framework/router.js';
import { installFluxerCompat } from '../platform/compat.js';
import { setFluxerInstance } from '../platform/instance.js';
import { installSendBridge } from '../platform/fluxerSendBridge.js';
import { registerFluxerModuleEvents } from './fluxerModuleEvents.js';
import { register as registerDmTickets } from './events/dmTickets.js';
import { fluxerReactionAdd } from '../platform/fluxerEvents.js';
import { createVoiceTracker } from '../platform/voiceStates.js';
import { handleReactionAdd } from '../platform/reactionBridge.js';

/**
 * The `instance` client option: which Fluxer instance to talk to. Hosted Fluxer
 * needs none. A self-hosted one publishes every endpoint (API, gateway, CDN,
 * invite host) at /.well-known/fluxer; when that can't be loaded, fall back to
 * the two origins we were configured with.
 * @param {{ webUrl?: string | null, apiUrl?: string | null }} origins
 * @param {typeof fetch} [fetchImpl]
 */
export async function resolveInstance({ webUrl, apiUrl }, fetchImpl = fetch) {
  if (!webUrl && !apiUrl) return undefined;
  if (webUrl) {
    try {
      const res = await fetchImpl(`${webUrl}/.well-known/fluxer`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.json();
      log.warn(
        'fluxer',
        `${webUrl}/.well-known/fluxer answered HTTP ${res.status}; using the configured origins`
      );
    } catch (err) {
      log.warn(
        'fluxer',
        `could not load ${webUrl}/.well-known/fluxer (${err.message}); using the configured origins`
      );
    }
  }
  return {
    ...((apiUrl || webUrl) && { api_public: apiUrl ?? `${webUrl}/api` }),
    ...(webUrl && { webapp: webUrl }),
  };
}

/**
 * @param {object} [opts]  every field defaults from config; tests inject them
 * @param {any} [opts.sdk]  the @fluxerjs/core module
 * @param {string} [opts.token]
 * @param {object} [opts.instance]
 * @param {Map<string, { data: any, execute: Function }>} [opts.commands]
 * @param {string} [opts.prefix]
 * @param {() => Promise<unknown>} [opts.loadModules]  registers every module's event handlers
 * @param {(sdk: any, deps: object) => void} [opts.installCompat]
 * @param {{ Collection: any }} [opts.collection]
 */
export async function startFluxerBot(opts = {}) {
  const sdk = opts.sdk ?? (await import('@fluxerjs/core'));
  const token = opts.token ?? config.fluxerToken;
  const prefix = opts.prefix ?? config.commandPrefix;
  const commands = opts.commands ?? (await loadCommands());
  // Importing the modules registers their event handlers (and starts their timers).
  await (opts.loadModules ?? (() => import('../modules/index.js')))();
  const instance =
    'instance' in opts
      ? opts.instance
      : await resolveInstance({ webUrl: config.fluxerWebUrl, apiUrl: config.fluxerApiUrl });

  const { Collection } = opts.collection ?? (await import('@fluxerjs/collection'));
  const voice = createVoiceTracker({ Collection });
  (opts.installCompat ?? installFluxerCompat)(sdk, { Collection, voice });
  setFluxerInstance(instance);
  // Before any message is sent: components become reactions, discord.js files are converted.
  installSendBridge({ channelClasses: [sdk.TextChannel, sdk.DMChannel], Message: sdk.Message });

  const client = new sdk.Client({
    ...(instance && { instance }),
    // Emit Ready only after every guild has arrived, so startup work sees the full guild list.
    waitForGuilds: true,
    // Replies don't ping the author unless a command asks for it.
    defaultReplyPing: false,
  });
  client.commands = commands;

  client.on('error', (err) => log.error('fluxer', 'gateway client error', err));
  client.once('ready', () =>
    log.info('fluxer', `Logged in as ${client.user?.username} - serving ${client.guilds.cache.size} guild(s)`)
  );
  registerFluxerModuleEvents(client, {
    voice,
    isCommand: (message) => isCommandMessage(message, { commands, prefix }),
  });
  registerDmTickets(client); // a DM to the bot opens a ticket, as on Discord
  attachPrefixCommands(client, { commands, prefix });
  client.on('messageReactionAdd', async (payload) => {
    try {
      const pair = await fluxerReactionAdd(client, payload);
      if (pair) await handleReactionAdd(pair.reaction, pair.user, { platform: 'fluxer' });
    } catch (err) {
      log.error('fluxer', 'reaction handling failed:', err);
    }
  });

  await client.login(token);
  setClientFor('fluxer', client);
  return client;
}
