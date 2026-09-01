// Wires the Giveaways module's "Enter" button handler.
import { registerGiveawayComponentHandlers } from '../../modules/giveaways.js';

/** @param {import('discord.js').Client} client */
export function register(client) {
  registerGiveawayComponentHandlers(client);
}
