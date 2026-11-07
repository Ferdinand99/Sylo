// The read-only part of the new dashboard's API that needs no login: the slash-command reference
// and the roadmap. Mounted at /api/v2/public in server.js, BEFORE requireAuth (the rest of
// /api/v2 sits behind it), with its own rate limit. Each answer
// carries only what the public pages show (see lib/roadmapView.js and
// lib/commandReference.js); nothing here may return user ids, guilds or settings.
import { Router } from 'express';
import { config } from '../../config.js';
import { primaryClient } from '../../platform/platformOf.js';
import { isOwner, sessionUserId } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { describeCommands } from '../lib/commandReference.js';
import { roadmapView } from '../lib/roadmapView.js';

const router = Router();

// Whether this visitor has a session, so the page can choose between the signed-in dashboard
// and the public layout without calling an endpoint that would answer 401.
router.get('/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ signedIn: Boolean(req.account), open: !config.authEnabled });
});

router.get('/commands', (req, res) => {
  res.json({ commands: describeCommands(primaryClient()?.commands) });
});

// The board as the visitor sees it: a signed-in person also gets their own votes and pending
// suggestions, so the answer must not be shared between people by a cache.
router.get(
  '/roadmap',
  asyncHandler(async (req, res) => {
    const userId = sessionUserId(req);
    res.set('Cache-Control', 'private, no-cache');
    res.json(await roadmapView({ userId, owner: userId ? isOwner(req) : false }));
  })
);

// Nothing else is public: an unknown path here is a 404, never a fall-through to the dashboard.
router.use((req, res) => res.status(404).json({ error: 'Not found' }));

export default router;
