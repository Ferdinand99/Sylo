// Public inbound endpoint: GitHub POSTs here when something happens in a
// watched repo. Mounted in server.js BEFORE the global express.json() parser
// — this needs the exact raw request bytes to verify the HMAC signature, so
// it parses its own body with express.raw() and JSON.parses it manually only
// after the signature checks out. Never trust anything in the payload before
// that check passes.
import { Router, raw } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGithubWatchByToken } from '../../db/githubWatches.js';
import { isModuleEnabled } from '../../db/modules.js';
import {
  verifyGithubSignature,
  formatGithubEvent,
  applyRolePing,
  pushTouchedPath,
  fetchChangelogBlock,
  formatChangelogPost,
} from '../../modules/githubAlerts.js';
import { log } from '../../lib/log.js';
import { postToChannel } from '../../modules/lib/send.js';

const router = Router();

// Keyed by the URL token (one watch), not by IP — see rateLimit.js's keyFn doc.
const webhookLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyFn: (req) => `gh|${req.params.token}`,
});

router.post(
  '/:token',
  webhookLimit,
  raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const watch = await getGithubWatchByToken(req.params.token);
    if (!watch) return res.status(404).end();

    if (!verifyGithubSignature(watch.secret, req.body, req.get('X-Hub-Signature-256'))) {
      return res.status(401).end();
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).end();
    }

    // Signature is valid, so the request is genuinely from this repo's
    // webhook — but still respect the module/watch being switched off.
    if (!watch.enabled || !(await isModuleEnabled(watch.guild_id, 'github'))) {
      return res.status(200).end();
    }

    const eventName = req.get('X-GitHub-Event') || '';
    if (eventName === 'ping') {
      // GitHub sends this the moment the webhook is created — the built-in
      // connectivity test, so there's no separate "send a test message" UI.
      await postToChannel(watch.guild_id, watch.channel_id, {
        embeds: [{ color: 0x2ea043, description: `✅ **${watch.repo}** is now connected to this channel.` }],
      });
      return res.status(200).end();
    }

    // Changelog watching is independent of the `events` checkboxes above —
    // it fires purely off `changelog_path` being set, whether or not 'push'
    // itself is also checked (they're not mutually exclusive: a watch can
    // post both the generic commit list and the extracted changelog entry).
    if (eventName === 'push' && watch.changelog_path && pushTouchedPath(payload, watch.changelog_path)) {
      if (payload?.repository?.private) {
        log.warn('module:github', `changelog watch on ${watch.repo}: private repos aren't supported yet`);
      } else {
        const ref = payload.after ?? payload.head_commit?.id;
        const block = ref ? await fetchChangelogBlock(watch.repo, watch.changelog_path, ref) : null;
        if (block) {
          const message = formatChangelogPost(watch.repo, block, payload.compare);
          await postToChannel(watch.guild_id, watch.channel_id, applyRolePing(message, watch.role_id));
        }
      }
    }

    if (watch.events.includes(eventName)) {
      const message = formatGithubEvent(eventName, payload);
      if (message) {
        await postToChannel(watch.guild_id, watch.channel_id, applyRolePing(message, watch.role_id));
      }
    }

    res.status(200).end();
  })
);

export default router;
