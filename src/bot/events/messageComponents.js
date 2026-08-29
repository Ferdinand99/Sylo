// Wires the Message Creator's role-button / role-select interaction handlers.
import { registerMessageComponentHandlers } from '../../modules/messageCreator.js';

/** @param {import('discord.js').Client} client */
export function register(client) {
  registerMessageComponentHandlers(client);
}
