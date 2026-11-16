// The operators' update notice (GET /api/v2/update and, with Wise Wren set up, "Update now"). Every route
// here is operator-only (OWNER_IDS / FLUXER_OWNER_IDS, requireOwner): a new release and Sylo's own updater
// are about the whole instance, not one server, so a server admin gets nothing, not even the version of
// the newest release. Writes carry the usual CSRF check (app-wide) and the approve route its own small
// rate limit. Used by the dashboard's Health page and top bar and by the Sylo app's operator screens
// (feature `update-notice`, docs/mobile-app.md).
import { createRequire } from 'node:module';
import { accessRouter } from '../middleware/access.js';
import { currentUser, requireOwner } from '../middleware/auth.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { createUpdateService, toUpdateError } from '../lib/updateService.js';
import { createUpdateChecker } from '../../lib/updateCheck.js';
import { createWrenClient } from '../../lib/wiseWren.js';
import { recordBotAudit } from '../../db/botAudit.js';
import { getAppSetting, setAppSetting } from '../../db/appSettings.js';
import { config } from '../../config.js';
import { log } from '../../lib/log.js';

const { version } = createRequire(import.meta.url)('../../../package.json');

const router = accessRouter('');

// The run Sylo last approved, kept in the database so it is still known after the restart the update
// causes (and "Update now" stays off while it runs). Only the run id, and only for the same target.
const RUN_KEY = 'update.wren.lastRun';
const runStore = {
  async get() {
    try {
      const run = JSON.parse((await getAppSetting(RUN_KEY)) ?? 'null');
      return Number.isSafeInteger(run?.id) && run.targetId === config.wiseWren?.targetId
        ? { id: run.id }
        : null;
    } catch {
      return null;
    }
  },
  async set(run) {
    await setAppSetting(RUN_KEY, JSON.stringify({ id: run.id, targetId: config.wiseWren?.targetId }));
  },
};

/**
 * Open mode (no dashboard login): nobody is signed in, so "Update now" is refused unless
 * WISE_WREN_ALLOW_OPEN_MODE=true.
 */
const openModeBlocked = () => !config.authEnabled && !config.wiseWrenAllowOpenMode;

/** The one service the routes use; tests that need another call `setUpdateService`. */
let service = createUpdateService({
  checker: createUpdateChecker({ enabled: config.updateCheck, version, log }),
  wren: config.wiseWren ? createWrenClient(config.wiseWren) : null,
  store: runStore,
  openModeBlocked,
});

/** Replace the service (tests only). */
export function setUpdateService(next) {
  service = next;
}

// Per operator (or per client in open mode), so one person's polling cannot use another's budget.
const who = (req) => req.account?.id ?? clientKey(req);
const readLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Too many update checks — wait a moment.',
  keyFn: (req) => `update-read|${who(req)}`,
});
// "Check again" asks GitHub: a few a minute is plenty.
const refreshLimit = rateLimit({
  windowMs: 60_000,
  max: 6,
  message: 'Too many re-checks — wait a minute.',
  keyFn: (req) => `update-refresh|${who(req)}`,
});
// An update restarts Sylo; nobody needs more than a handful of attempts a minute.
const approveLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: 'Too many update requests — wait a minute.',
  keyFn: (req) => `update-approve|${who(req)}`,
});
// The page polls a run every few seconds while Sylo updates.
const runLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many progress checks — wait a moment.',
  keyFn: (req) => `update-run|${who(req)}`,
});

/** Wise Wren's refusals as JSON; anything else is a real error for the error handler. */
function fail(err, res, next) {
  const mapped = toUpdateError(err);
  if (!mapped) return next(err);
  if (mapped.status >= 500) log.debug('update', `Wise Wren: ${mapped.code}`);
  return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
}

const wantsFresh = (req) => ['1', 'true'].includes(String(req.query.refresh ?? ''));

router.get(
  '/update',
  requireOwner,
  (req, res, next) => (wantsFresh(req) ? refreshLimit(req, res, next) : next()),
  readLimit,
  asyncHandler(async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await service.status({ force: wantsFresh(req) }));
    } catch (err) {
      fail(err, res, next);
    }
  })
);

router.post(
  '/update/wren/approve',
  requireOwner,
  approveLimit,
  asyncHandler(async (req, res, next) => {
    try {
      const started = await service.approve();
      // Who asked, for the Health page's bot-wide audit log. Never the run's text or any token.
      try {
        await recordBotAudit({
          actor: currentUser(req)?.open ? 'Dashboard' : `${currentUser(req)?.name ?? 'operator'} (dashboard)`,
          action: 'update:approve',
          detail: `asked Wise Wren to update Sylo from ${started.from} (run ${started.runId})`,
        });
      } catch (err) {
        log.debug('update', 'audit entry failed:', err);
      }
      log.info('update', `an operator approved the Sylo update in Wise Wren (run ${started.runId})`);
      res.json(started);
    } catch (err) {
      fail(err, res, next);
    }
  })
);

router.get(
  '/update/wren/runs/:id',
  requireOwner,
  runLimit,
  asyncHandler(async (req, res, next) => {
    const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await service.run(id));
    } catch (err) {
      fail(err, res, next);
    }
  })
);

export default router;
