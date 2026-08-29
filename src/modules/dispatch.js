// Fans gateway events out to enabled modules. A module registers handlers with
// on(moduleId, eventName, fn); dispatch(eventName, guildId, payload) then calls
// each handler whose module is enabled for that guild, passing the module's
// stored config.
import { isModuleEnabled, getGuildModule } from '../db/modules.js';

/** @type {Map<string, Array<{ moduleId: string, fn: Function }>>} */
const handlers = new Map();

/**
 * @param {string} moduleId
 * @param {string} eventName
 * @param {(payload: any, config: object, guildId: string) => any} fn
 */
export function on(moduleId, eventName, fn) {
  if (!handlers.has(eventName)) handlers.set(eventName, []);
  handlers.get(eventName).push({ moduleId, fn });
}

/**
 * @param {string} eventName
 * @param {string | null | undefined} guildId
 * @param {any} payload
 */
export async function dispatch(eventName, guildId, payload) {
  if (!guildId) return;
  const list = handlers.get(eventName);
  if (!list) return;
  for (const { moduleId, fn } of list) {
    if (!isModuleEnabled(guildId, moduleId)) continue;
    try {
      await fn(payload, getGuildModule(guildId, moduleId).config, guildId);
    } catch (err) {
      console.error(`[module:${moduleId}] ${eventName} handler failed:`, err);
    }
  }
}
