// The cached game-stats lookups as the operators' "Cached stats" view shows them. Shared by the
// classic /stats page and the new dashboard's /api/v2/stats. Read-only: never triggers a live API call.
import { config } from '../../config.js';
import { listCached } from '../../db/cache.js';
import { timeAgo } from './format.js';

/** The newest `limit` cached lookups, shaped for display. */
export async function statsCacheRows(limit = 50) {
  return (await listCached(limit)).map((row) => {
    const ageMs = Date.now() - row.created_at;
    return {
      game: row.game,
      title: row.title,
      username: row.username,
      platform: row.platform,
      ago: timeAgo(row.created_at),
      fresh: ageMs <= config.cacheTtlMs,
      kd: row.payload?.kd ?? '—',
      winRate: row.payload?.winRate ?? '—',
      timePlayed: row.payload?.timePlayed ?? '—',
    };
  });
}
