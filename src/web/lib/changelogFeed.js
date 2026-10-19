// GET /api/v2/changelog: Sylo's CHANGELOG.md as JSON for the Sylo app, parsed the same way as the
// V2 "What's new" page (src/lib/changelog.js), so the web and the app say the same.
import { readFile as fsReadFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { changelogFeed } from '../../lib/changelog.js';
import { log } from '../../lib/log.js';

const { version } = createRequire(import.meta.url)('../../../package.json');

/** The repo's CHANGELOG.md, found from this file rather than the working directory. */
const CHANGELOG = new URL('../../../CHANGELOG.md', import.meta.url);
export const MAX_RELEASES = 200;

/** `?limit=N`: a positive whole number, at most MAX_RELEASES; anything else means every release. */
function parseLimit(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_RELEASES) : undefined;
}

/**
 * The route handler. CHANGELOG.md is read and parsed on the first request and kept in memory:
 * it only changes with a new release, which means a restart. A missing file (some dev setups)
 * gives an empty list rather than an error.
 */
export function changelogHandler({ path = CHANGELOG, readFile = (p) => fsReadFile(p, 'utf8') } = {}) {
  let releases = null;
  const load = () => {
    releases ??= Promise.resolve()
      .then(() => readFile(path))
      .then((md) => changelogFeed(md))
      .catch((err) => {
        if (err.code !== 'ENOENT') log.warn('changelog', 'could not read CHANGELOG.md:', err.message);
        return [];
      });
    return releases;
  };
  return async (req, res) => {
    const all = await load();
    const limit = parseLimit(req.query.limit);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ version, releases: all.slice(0, limit) });
  };
}
