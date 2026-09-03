// Game adapter bootstrap: register every available adapter here.
// Adding a new game = create its adapter file, then add one import + register()
// line below. Nothing else in the codebase needs to change.
import { register } from './registry.js';
import { battlefieldAdapter } from './battlefield.js';
import { runescapeAdapter } from './runescape.js';

register('battlefield', battlefieldAdapter);
register('runescape', runescapeAdapter);

export { getAdapter, listGames } from './registry.js';
