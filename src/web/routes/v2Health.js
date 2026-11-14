// The permission and role-hierarchy health check of one server (GET /api/v2/guilds/:guildId/health).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set and the caller
// manages this server: another server's health, or any health for someone who does not manage this
// one, is refused before this file runs. The report is built by lib/permissionHealth.js and cached
// per server for a minute (a settings save drops it); `?refresh=1` re-checks at once, behind its own
// small rate limit, because that walks every channel and role of the server again.
import { accessRouter } from '../middleware/access.js';
import { isOwner } from '../middleware/auth.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { invalidateHealth } from '../../lib/healthCache.js';
import { getHealthReport, reportFor } from '../lib/permissionHealth.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

// One re-check budget per server and person.
const recheckLimit = rateLimit({
  windowMs: 60_000,
  max: 6,
  message: 'Too many re-checks — wait a minute.',
  keyFn: (req) => `health-recheck|${req.params?.guildId ?? ''}|${req.account?.id ?? clientKey(req)}`,
});

const wantsFresh = (req) => ['1', 'true'].includes(String(req.query.refresh ?? ''));

router.get(
  '/health',
  (req, res, next) => (wantsFresh(req) ? recheckLimit(req, res, next) : next()),
  asyncHandler(async (req, res) => {
    const report = await getHealthReport(req.guild, { fresh: wantsFresh(req) });
    res.set('Cache-Control', 'no-store');
    res.json({ guildId: req.guild.id, ...reportFor(report, { owner: isOwner(req) }) });
  })
);

/**
 * Any dashboard save on a server (a module's settings, a reminder, a shop item, an application form
 * ...) can change what the health check reads, so the cached report is dropped once the request is done.
 * Mounted on the guild routers after the access guard; reads leave the cache alone.
 * @type {import('express').RequestHandler}
 */
export function dropHealthOnWrite(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.guild?.id) {
    // Now, so a read that is already waiting cannot cache the old state, and again when the answer is out,
    // so a read that came in while the save was running does not keep it.
    invalidateHealth(req.guild.id);
    res.on('finish', () => invalidateHealth(req.guild.id));
  }
  next();
}

export default router;
