// JSON API for the Bridge page of the dashboard: the links of a server, asking for a link, accepting one
// with a code, the options of this server's side, and pause, resume and unlink. The rules live in
// modules/bridge.js.
//
// Mounted at /guilds/:guildId AFTER the access guard in v2Api.js, so req.guild is set and the caller has
// the level routeAccess.js gives each route: View reads the page, Edit changes anything. Every link is
// looked up through the server in the URL (a link names two servers, and a server may only see and change
// its own side), so another server's link id is a 404 here.
import { accessRouter } from '../middleware/access.js';
import { currentUser, userIdForGuild } from '../middleware/auth.js';
import { clientKey, platformActionLimit, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { GuildOwnerError, isGuildOwner, requireGuildOwner } from '../lib/guildOwner.js';
import { sweepMap } from '../../lib/sweepMap.js';
import {
  BridgeError,
  acceptLink,
  assertActorMayUse,
  bridgeOverview,
  cancelRequest,
  pauseLink,
  requestLink,
  resumeLink,
  setSideOptions,
  unlinkLink,
} from '../../modules/bridge.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));
const linkId = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new BridgeError('No such bridged channel in this server.', 404);
  return n;
};

/**
 * Run a changing handler. Every change to a bridge is the SERVER OWNER's alone (the owner the platform reports
 * for this server, worked out again on every call): Edit access, Administrator and the bot-master roles do
 * not reach it. View access reads the page (the GET below). A refusal becomes its own status and message.
 */
const guarded = (fn) =>
  asyncHandler(async (req, res) => {
    try {
      requireGuildOwner(req, req.guild.id);
      await fn(req, res);
    } catch (err) {
      if (err instanceof BridgeError || err instanceof GuildOwnerError) {
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }
  });

// A code is about 59 bits, so guessing one is hopeless; the limits are about not letting the endpoint be a
// way to hammer the platforms (every accept makes webhooks) or to try codes at speed. One budget per
// person, whichever server they are in, and a lock after several wrong codes.
const acceptLimit = rateLimit({
  windowMs: 60_000,
  max: 8,
  message: 'Too many attempts. Wait a minute and try again.',
  keyFn: (req) => `bridge-accept|${req.account?.id ?? clientKey(req)}`,
});
const WRONG_LIMIT = 6;
const WRONG_WINDOW_MS = 10 * 60_000;
const wrong = new Map(); // `${person}|${server}` -> { n, at }
sweepMap(wrong, (v, now) => now - v.at > WRONG_WINDOW_MS);
const who = (req) => `${req.account?.id ?? clientKey(req)}|${req.params.guildId}`;
const locked = (req) => {
  const hit = wrong.get(who(req));
  return Boolean(hit && Date.now() - hit.at < WRONG_WINDOW_MS && hit.n >= WRONG_LIMIT);
};
const noteWrong = (req) => {
  const id = who(req);
  const hit = wrong.get(id);
  wrong.set(id, { n: (hit && Date.now() - hit.at < WRONG_WINDOW_MS ? hit.n : 0) + 1, at: Date.now() });
};

// `owner`: may this person change the bridge? The page shows the status to everyone with View access and
// enables the controls only for the owner.
const overview = async (req) => ({
  ...(await bridgeOverview(req.guild.id)),
  owner: isGuildOwner(req, req.guild.id),
});

// The person must be able to view, read and send in the channel themselves (Edit access alone is not enough:
// a bot-master may not see every channel, and the bridge would carry it to a server they run).
async function requireActorAccess(req, channelId) {
  const user = currentUser(req);
  if (user?.open) return;
  const userId = userIdForGuild(req, req.guild.id);
  const guild = req.guild;
  const member = userId
    ? (guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null)))
    : null;
  assertActorMayUse(guild.id, channelId, member);
}

router.get(
  '/modules/bridge/config',
  asyncHandler(async (req, res) => {
    res.json(await overview(req));
  })
);

router.post(
  '/modules/bridge/request',
  platformActionLimit,
  guarded(async (req, res) => {
    if (!isId(req.body?.channelId)) throw new BridgeError('Pick a channel.');
    await requireActorAccess(req, String(req.body.channelId));
    const made = await requestLink({
      guildKey: req.guild.id,
      channelId: String(req.body.channelId),
      options: req.body?.options,
      actor: actor(req),
    });
    // The code is shown once: only its hash is stored.
    res.json({ code: made.code, expiresAt: made.expiresAt, overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/requests/:id/cancel',
  guarded(async (req, res) => {
    await cancelRequest({ guildKey: req.guild.id, id: linkId(req), actor: actor(req) });
    res.json({ overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/accept',
  acceptLimit,
  platformActionLimit,
  guarded(async (req, res) => {
    if (locked(req)) {
      throw new BridgeError('Too many wrong codes. Wait a few minutes before trying again.', 429);
    }
    if (!isId(req.body?.channelId)) throw new BridgeError('Pick a channel.');
    await requireActorAccess(req, String(req.body.channelId));
    try {
      await acceptLink({
        guildKey: req.guild.id,
        channelId: String(req.body.channelId),
        code: String(req.body?.code ?? ''),
        options: req.body?.options,
        actor: actor(req),
      });
    } catch (err) {
      // Only a code that did not work counts as wrong; a channel problem is the person's to fix.
      if (err instanceof BridgeError && err.status === 404) noteWrong(req);
      throw err;
    }
    res.json({ overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/links/:id/options',
  guarded(async (req, res) => {
    await setSideOptions({
      guildKey: req.guild.id,
      id: linkId(req),
      options: req.body?.options ?? {},
      actor: actor(req),
    });
    res.json({ overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/links/:id/pause',
  platformActionLimit,
  guarded(async (req, res) => {
    await pauseLink({ guildKey: req.guild.id, id: linkId(req), actor: actor(req) });
    res.json({ overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/links/:id/resume',
  platformActionLimit,
  guarded(async (req, res) => {
    await resumeLink({ guildKey: req.guild.id, id: linkId(req), actor: actor(req) });
    res.json({ overview: await overview(req) });
  })
);

router.post(
  '/modules/bridge/links/:id/unlink',
  guarded(async (req, res) => {
    await unlinkLink({ guildKey: req.guild.id, id: linkId(req), actor: actor(req) });
    res.json({ overview: await overview(req) });
  })
);

export default router;
