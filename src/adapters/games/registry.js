// Registry mapping a game id to its adapter implementation.
// The bot and web layers only ever talk to the registry, never to a specific
// adapter file, so a new game is a pure addition.
import { UnsupportedGameError } from './gameAdapter.js';

/** @type {Map<string, import('./gameAdapter.js').PlayerStats extends never ? never : any>} */
const adapters = new Map();

/**
 * Register an adapter under its id.
 * @param {string} id
 * @param {{ id: string, titles: () => string[], platformsFor: (title: string) => string[], getPlayerStats: Function }} adapter
 */
export function register(id, adapter) {
  if (adapters.has(id)) {
    throw new Error(`Adapter "${id}" is already registered`);
  }
  adapters.set(id, adapter);
}

/**
 * Look up an adapter by id.
 * @param {string} id
 * @returns {{ id: string, titles: () => string[], platformsFor: (title: string) => string[], getPlayerStats: Function }}
 * @throws {UnsupportedGameError} when no adapter is registered for the id.
 */
export function getAdapter(id) {
  const adapter = adapters.get(id);
  if (!adapter) throw new UnsupportedGameError(id);
  return adapter;
}

/** All registered game ids. */
export function listGames() {
  return [...adapters.keys()];
}
