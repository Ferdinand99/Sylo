// Wires the Verification module's "Verify" button handler.
import { registerVerificationHandlers } from '../../modules/verification.js';

/** @param {import('discord.js').Client} client */
export function register(client) {
  registerVerificationHandlers(client);
}
