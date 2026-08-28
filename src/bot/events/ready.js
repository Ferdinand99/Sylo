// Fires once when the Discord client has finished connecting.
import { ActivityType, Events } from 'discord.js';

export const name = Events.ClientReady;
export const once = true;

/** @param {import('discord.js').Client} client */
export function execute(client) {
  console.log(`[bot] Logged in as ${client.user.tag} - serving ${client.guilds.cache.size} guild(s)`);
  client.user.setPresence({
    status: 'online',
    activities: [{ name: '/stats battlefield', type: ActivityType.Listening }],
  });
}
