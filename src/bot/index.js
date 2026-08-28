// Discord client bootstrap: build the client, load commands and events,
// register slash commands, and log in.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { setClient, setLastError } from '../runtime.js';
import { loadCommands } from './loadCommands.js';
import { registerCommands } from './registerCommands.js';

const eventsDir = join(dirname(fileURLToPath(import.meta.url)), 'events');

/** Wire up every event module in ./events onto the client. */
async function loadEvents(client) {
  const files = readdirSync(eventsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  for (const file of files) {
    const mod = await import(pathToFileURL(join(eventsDir, file)).href);
    if (!mod.name || typeof mod.execute !== 'function') {
      console.warn(`[bot] Skipping event ${file}: missing "name" or "execute" export`);
      continue;
    }
    if (mod.once) client.once(mod.name, (...args) => mod.execute(...args));
    else client.on(mod.name, (...args) => mod.execute(...args));
  }
}

/**
 * Create the client, load everything, register commands, and log in.
 * Resolves once login is initiated; the "ready" event finishes the handshake.
 * @returns {Promise<import('discord.js').Client>}
 */
export async function startBot() {
  // Slash commands only — no privileged intents or partials required.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const commands = await loadCommands();
  client.commands = commands;
  await loadEvents(client);

  // Surface library-level errors on the dashboard instead of letting them bubble.
  client.on('error', (err) => setLastError(err));
  client.on('shardError', (err) => setLastError(err));

  try {
    await registerCommands(commands);
  } catch (err) {
    // Non-fatal: the bot can still run with previously-registered commands.
    setLastError(err);
    console.error('[bot] Slash command registration failed:', err.message);
  }

  await client.login(config.discordToken);
  setClient(client);
  return client;
}
