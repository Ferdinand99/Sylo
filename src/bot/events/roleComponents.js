// Wires the Reaction Roles module's button / select-menu interaction handlers
// (the "buttons" and "select" message styles).
import { registerRoleComponentHandlers } from '../../modules/roles.js';

/** @param {import('discord.js').Client} client */
export function register(client) {
  registerRoleComponentHandlers(client);
}
