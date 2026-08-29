// Static build / runtime metadata, read once at startup. Used by the /version
// and /about commands and kept in step with what /health reports on the web.
import { createRequire } from 'node:module';
import { version as discordJsVersion } from 'discord.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json');

export const REPO_URL = 'https://github.com/Ferdinand99/Sylo';

/** @type {{ version: string, discordJs: string, node: string }} */
export const BUILD = Object.freeze({
  version: pkg.version,
  discordJs: discordJsVersion,
  node: process.versions.node,
});
