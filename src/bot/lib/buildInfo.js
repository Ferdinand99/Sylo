// Static build / runtime metadata, read once at startup. Used by the /version
// and /about commands and kept in step with what /health reports on the web.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { version as discordJsVersion } from 'discord.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json');

// The Fluxer SDK's `exports` map hides its package.json from require(), so read the file.
function fluxerSdkVersion() {
  try {
    const file = new URL('../../../node_modules/@fluxerjs/core/package.json', import.meta.url);
    return JSON.parse(readFileSync(file, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export const REPO_URL = 'https://github.com/Ferdinand99/Sylo';

/** @type {{ version: string, discordJs: string, fluxerJs: string, node: string }} */
export const BUILD = Object.freeze({
  version: pkg.version,
  discordJs: discordJsVersion,
  fluxerJs: fluxerSdkVersion(),
  node: process.versions.node,
});
