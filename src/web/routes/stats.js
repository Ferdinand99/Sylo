// GET /stats — browse the stats that have been queried through the bot.
// Read-only view over the cache table; it never triggers a live API call.
import { Router } from 'express';
import { config } from '../../config.js';
import { listCached } from '../../db/cache.js';
import { timeAgo } from '../lib/format.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = listCached(50).map((row) => {
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

  res.render('stats', { rows, ttlMinutes: config.cacheTtlMinutes });
});

export default router;
