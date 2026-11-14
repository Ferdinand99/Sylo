// Import of a configuration export (the file GET /guilds/:id/export gives): a preview that changes
// nothing, and an apply that needs a typed confirmation word. See lib/configImport.js for what is
// read, cleared and written, and how.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server, the CSRF check has passed and the role-grant guard knows who is saving.
import { Router } from 'express';
import { currentUser } from '../middleware/auth.js';
import { platformActionLimit, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  IMPORT_CONFIRM_WORD,
  ImportError,
  applyImport,
  planImport,
  publicPlan,
} from '../lib/configImport.js';

// One line to change when this router moves to the access levels: `Router(...)` becomes `accessRouter(...)`.
const router = Router({ mergeParams: true });

// Planning reads a few tables per module: a person importing does not need more than this.
const importLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Too many import requests — wait a minute.',
});

const MAX_ITEMS = 500;

/**
 * An apply can post messages (verification, honeypot), sync AutoMod and edit event posts, so it shares the
 * stricter limit of the other actions that call the platform. Checked after the request is validated, so a
 * refused request does not use it up.
 */
function withinPlatformLimit(req, res) {
  let allowed = false;
  platformActionLimit(req, res, () => {
    allowed = true;
  });
  return allowed;
}

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

/** The route body, with a bad file answered as the person's mistake. */
const guarded = (fn) =>
  asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ImportError) return fail(res, err.message);
      throw err;
    }
  });

// What the file would change, item by item.
router.post(
  '/import/preview',
  importLimit,
  guarded(async (req, res) => {
    res.json(publicPlan(await planImport(req.guild, req.body?.export)));
  })
);

// Apply the ticked items. `confirm` must be the word the preview names.
router.post(
  '/import/apply',
  importLimit,
  guarded(async (req, res) => {
    if (req.body?.confirm !== IMPORT_CONFIRM_WORD) {
      return fail(res, `Type ${IMPORT_CONFIRM_WORD} to confirm the import.`);
    }
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return fail(res, 'Pick what to import.');
    }
    const keys = items.filter((k) => typeof k === 'string' && k.length <= 100);
    if (!withinPlatformLimit(req, res)) return undefined;
    res.json(await applyImport(req.guild, req.body?.export, keys, { actor: actor(req) }));
  })
);

export default router;
