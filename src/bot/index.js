// Discord client bootstrap: build the client, load commands and events,
// register slash commands, and log in.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { setClient, setLastError } from '../runtime.js';
import { loadCommands } from './loadCommands.js';
import { registerCommands } from './registerCommands.js';

/** Build the gateway intent list from config. */
function buildIntents() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration, // ban add/remove, audit-log-adjacent events
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, // reaction roles
    GatewayIntentBits.DirectMessages, // ticket / modmail
  ];
  if (config.intentGuildMembers) intents.push(GatewayIntentBits.GuildMembers);
  if (config.intentMessageContent) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

const eventsDir = join(dirname(fileURLToPath(import.meta.url)), 'events');

/**
 * Wire up every event module in ./events onto the client. A module either
 * exports { name, execute[, once] } for a single listener, or a
 * register(client) function that attaches its own listeners.
 */
async function loadEvents(client) {
  const files = readdirSync(eventsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  for (const file of files) {
    const mod = await import(pathToFileURL(join(eventsDir, file)).href);
    if (typeof mod.register === 'function') {
      mod.register(client);
      continue;
    }
    if (!mod.name || typeof mod.execute !== 'function') {
      console.warn(`[bot] Skipping event ${file}: missing "name"/"execute" or "register" export`);
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
  const client = new Client({
    intents: buildIntents(),
    // Needed to receive reaction/message events for messages not in cache.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
  });

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

  try {
    await client.login(config.discordToken);
  } catch (err) {
    if (err?.code === 'DisallowedIntents' || /disallowed intents/i.test(err?.message ?? '')) {
      console.error(
        '[bot] Login failed: this bot is requesting privileged intents that are not enabled.\n' +
          '      Enable "Server Members Intent" and "Message Content Intent" on the Discord\n' +
          '      Developer Portal (Bot page) for this application — verified bots may also need\n' +
          '      Discord approval. To run without them for now, set INTENT_GUILD_MEMBERS=false\n' +
          '      and/or INTENT_MESSAGE_CONTENT=false.'
      );
    }
    throw err;
  }
  setClient(client);
  return client;
}
