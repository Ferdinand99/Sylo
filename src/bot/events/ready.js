// Fires once when the Discord client has finished connecting.
import { Events } from 'discord.js';
import { syncAllGuildCustomCommands } from '../lib/customCommandSync.js';
import { primeAllInviteCaches } from '../../modules/inviteTracker.js';
import { applyPresence } from '../lib/presence.js';

export const name = Events.ClientReady;
export const once = true;

/** @param {import('discord.js').Client} client */
export function execute(client) {
  console.log(`[bot] Logged in as ${client.user.tag} - serving ${client.guilds.cache.size} guild(s)`);

  // Presence is configured from the dashboard; re-apply periodically so
  // {servers} / {members} placeholders stay current as the bot joins/leaves.
  applyPresence(client);
  setInterval(() => applyPresence(client), 10 * 60 * 1000).unref();

  // Register slash custom commands for guilds that use them (runs after the
  // built-in command registration in startBot()).
  syncAllGuildCustomCommands(client).catch((err) =>
    console.error('[custom-commands] startup slash sync failed:', err.message)
  );

  // Cache each guild's current invite uses so the first join after a restart is
  // still attributable.
  primeAllInviteCaches(client).catch((err) =>
    console.error('[invite-tracker] startup invite cache prime failed:', err.message)
  );
}
