// Fires once when the Discord client has finished connecting.
import { ActivityType, Events } from 'discord.js';
import { syncAllGuildCustomCommands } from '../lib/customCommandSync.js';

export const name = Events.ClientReady;
export const once = true;

/** @param {import('discord.js').Client} client */
export function execute(client) {
  console.log(`[bot] Logged in as ${client.user.tag} - serving ${client.guilds.cache.size} guild(s)`);
  client.user.setPresence({
    status: 'online',
    activities: [{ name: '/stats battlefield', type: ActivityType.Listening }],
  });

  // Register slash custom commands for guilds that use them (runs after the
  // built-in command registration in startBot()).
  syncAllGuildCustomCommands(client).catch((err) =>
    console.error('[custom-commands] startup slash sync failed:', err.message)
  );
}
