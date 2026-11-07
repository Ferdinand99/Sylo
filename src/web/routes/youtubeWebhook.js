// Public inbound endpoint for YouTube's WebSub hub (see modules/youtubeWebsub.js). Mounted in
// server.js next to the GitHub webhook, BEFORE the global body parsers and the CSRF check: the
// push is signed over its exact bytes, so it parses its own body with express.raw(), and the
// hub cannot carry a dashboard session. Only mounted when WebSub is on (a public https
// DASHBOARD_URL). Nothing here returns HTML.
//
//   GET  /:channelId  the hub's verification request: echo hub.challenge as text/plain for a
//                     subscription we asked for, otherwise 404
//   POST /:channelId  an Atom push, signed `X-Hub-Signature: sha1=<hex>` (or sha256=) with the
//                     subscription's secret
import { Router, raw } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getWebsub } from '../../db/youtubeWebsub.js';
import {
  CHANNEL_RE,
  handleNotification,
  verifyIntent,
  verifySignature,
} from '../../modules/youtubeWebsub.js';
import { log } from '../../lib/log.js';

const router = Router();

/** A hub push is one small Atom entry; anything bigger is not one. */
export const MAX_BODY = '64kb';

// Keyed by channel, not client: the hub's requests all come from Google's few addresses.
const channelLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyFn: (req) => `yt|${req.params.channelId}`,
});
// The channel id is the caller's choice, so random ids would each get a fresh bucket above.
const clientLimit = rateLimit({ windowMs: 60_000, max: 600 });

// A channel id of any other shape is a 404 before the limiters, the body and the database.
router.param('channelId', (req, res, next, channelId) => {
  if (!CHANNEL_RE.test(channelId)) return res.status(404).end();
  next();
});

router.get(
  '/:channelId',
  clientLimit,
  channelLimit,
  asyncHandler(async (req, res) => {
    const challenge = await verifyIntent(req.params.channelId, req.query);
    if (challenge === null) return res.status(404).end();
    res.status(200).type('text/plain').send(challenge);
  })
);

router.post(
  '/:channelId',
  clientLimit,
  channelLimit,
  raw({ type: () => true, limit: MAX_BODY }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.params;
    const row = await getWebsub(channelId);
    if (!row) return res.status(404).end();

    // A missing or wrong signature still gets a 2xx: WebSub (section 8, "Authenticated Content
    // Distribution") says the subscriber acknowledges receipt but ignores the content, so the hub
    // does not keep redelivering. Nothing is announced, and it is logged at debug level only.
    if (!verifySignature(row.secret, req.body, req.get('X-Hub-Signature'))) {
      log.debug('youtube-alerts', `push for ${channelId} ignored: missing or wrong signature`);
      return res.status(204).end();
    }

    try {
      await handleNotification(channelId, req.body.toString('utf8'));
    } catch (err) {
      // The hub has delivered; a repeat would not help. The poll still catches the video.
      log.error('youtube-alerts', `push ${channelId}:`, err.message);
    }
    res.status(204).end();
  })
);

// A body over the cap: 413, not the dashboard's generic 500.
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).end();
  next(err);
});

export default router;
