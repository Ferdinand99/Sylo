// Which platform a client / guild belongs to. Every guild object carries its
// client, and each platform has exactly one client in runtime.clients, so the
// answer needs no id parsing. Anything unrecognised is Discord — the platform
// every existing code path was written for.
import { runtime } from '../runtime.js';
import { supports } from './capabilities.js';

/** @returns {'discord' | 'fluxer'} */
export function platformOfClient(client) {
  return client && runtime.clients.fluxer === client ? 'fluxer' : 'discord';
}

/** @returns {'discord' | 'fluxer'} */
export const platformOfGuild = (guild) => platformOfClient(guild?.client);

/** Does this guild's platform support `feature`? (see capabilities.js) */
export const guildSupports = (guild, feature) => supports(platformOfGuild(guild), feature);
