// One router for every message-component interaction (buttons, select menus).
// Modules register a customId prefix and a handler at import time; the single
// listener in events/interactionCreate.js dispatches to the first match and owns
// the shared error handling. Mirrors modules/dispatch.js for gateway events.
import { MessageFlags } from 'discord.js';
import { log } from '../../lib/log.js';

/** @type {Array<{ scope: string, prefix: string, fn: Function }>} */
const routes = [];

/**
 * @param {string} scope   label for error logs (usually the module id)
 * @param {string} prefix  customId prefix, e.g. 'rr:', 'verify:start', 'msgroles'
 * @param {(interaction: import('discord.js').MessageComponentInteraction) => any} fn
 */
export function registerComponent(scope, prefix, fn) {
  routes.push({ scope, prefix, fn });
  // Longest prefix wins so 'rrsel:' is matched before a hypothetical 'rr'.
  routes.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Test seam — drop all registrations. */
export function _resetComponents() {
  routes.length = 0;
}

/**
 * Route one message-component interaction to its handler.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @returns {Promise<boolean>} true if a handler matched
 */
export async function routeComponent(interaction) {
  const route = routes.find((r) => interaction.customId.startsWith(r.prefix));
  if (!route) return false;
  try {
    await route.fn(interaction);
  } catch (err) {
    log.error(route.scope, `component "${interaction.customId}" failed:`, err.message ?? err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}
