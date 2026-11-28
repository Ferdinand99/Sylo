// The mirror's entries in a server's health report (src/web/lib/permissionHealth.js): a mirror that paused
// itself because Fluxer kept refusing or failing, and a copy that finished with items that failed. Both
// servers of a pair show the entry, because either side's admins may be the one who can fix it.
import { PAIR_STATUS, listFailedJobs, pairsOfGuild } from '../db/mirror.js';
import { v2CardHref } from '../web/lib/overviewSummary.js';

/**
 * @param {string} guildKey
 * @returns {Promise<object[]>} checks in the shape of the health report
 */
export async function mirrorHealthChecks(guildKey) {
  const checks = [];
  for (const pair of await pairsOfGuild(guildKey)) {
    const base = {
      module: 'mirror',
      moduleName: 'Mirror to Fluxer',
      href: v2CardHref('mirror', guildKey),
    };
    if (pair.status === PAIR_STATUS.PAUSED && pair.lastError) {
      checks.push({
        ...base,
        severity: 'error',
        kind: 'mirror',
        code: 'mirror-paused',
        message: `The mirror to Fluxer is paused: ${pair.lastError}`,
        fix: 'Fix what the message says, then press Resume on the Mirror page.',
      });
      continue;
    }
    if ([PAIR_STATUS.LIVE, PAIR_STATUS.DONE, PAIR_STATUS.COPYING].includes(pair.status)) {
      const failed = await listFailedJobs(pair.id, 50);
      const current = failed.filter((j) => j.run === pair.copyRun || j.phase === 'sync');
      if (current.length > 0) {
        checks.push({
          ...base,
          severity: 'warning',
          kind: 'mirror',
          code: 'mirror-items-failed',
          message: `${current.length} item(s) could not be copied to Fluxer, for example ${current[0].payload?.name ?? current[0].sourceId}: ${current[0].detail}`,
          fix: 'Open the report on the Mirror page to see them all.',
        });
      }
    }
  }
  return checks;
}
