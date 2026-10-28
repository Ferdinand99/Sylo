// GET /stats — browse the stats that have been queried through the bot.
// Read-only view over the cache table; it never triggers a live API call.
import { Router } from 'express';
import { config } from '../../config.js';
import { statsCacheRows } from '../lib/statsCache.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('stats', { rows: await statsCacheRows(50), ttlMinutes: config.cacheTtlMinutes });
  })
);

export default router;
