// JSON API for the "Mirror to Fluxer" page: copy a Discord server's structure to a Fluxer server and keep it
// in step (src/mirror/).
//
// Mounted at /guilds/:guildId in v2Api.js behind the access guard, so req.guild is set and the caller has a
// dashboard level in THIS server. The levels are in src/web/lib/routeAccess.js: seeing the page and its
// preview and report needs View. Everything that changes anything (asking, agreeing, the options, starting,
// pausing, resuming, stopping, removing) is Edit in the table and, on top of that, only the owner of the server
// the call is made on (isGuildOwner in src/web/lib/guildOwner.js): an Administrator, an Edit holder or a bot master is not enough.
//
// The page is used on both servers of a pair. On the Discord server (the source) its owner asks for a mirror,
// looks at the preview and starts the copy. On the Fluxer server (the target) its owner agrees with the code the
// request showed, and may pause or stop the mirror at any time. Every call looks only at the pair this server is
// part of, so a code, a pair id or a server id of another server reaches nothing.
import { config } from '../../config.js';
import { splitPlatformGuildId, makePlatformGuildId } from '../../lib/platformId.js';
import { PAIR_STATUS, pairsOfGuild, updatePair } from '../../db/mirror.js';
import { recordAudit } from '../../db/audit.js';
import { accessRouter } from '../middleware/access.js';
import { isBeta } from '../../modules/registry.js';
import { adminGuildIds, currentUser, userIdForGuild } from '../middleware/auth.js';
import { identityFor } from '../lib/accountAuth.js';
import { isGuildOwner } from '../lib/guildOwner.js';
import { platformActionKey, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildByKey, platformOfGuild } from '../../platform/platformOf.js';
import { mirror } from '../../mirror/index.js';
import { ConsentError, acceptMirror, requestMirror } from '../../mirror/consent.js';
import { MirrorError } from '../../mirror/errors.js';
import { DEFAULT_OPTIONS, FLUXER_LIMITS, normaliseOptions } from '../../mirror/spec.js';
import { createFluxerTarget } from '../../mirror/target.js';
import { invalidateHealth } from '../../lib/healthCache.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400, extra = {}) =>
  res.status(status).json({ error: message, ...extra });

// Asking and agreeing change who may write to a server: a few tries in ten minutes per server and person.
const askLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 12,
  message: 'Too many mirror requests just now. Wait a few minutes and try again.',
  keyFn: (req) => `mirror-ask|${platformActionKey(req)}`,
});
// The preview reads both servers whole.
const previewLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'The preview was asked for too often. Wait a minute.',
  keyFn: (req) => `mirror-preview|${platformActionKey(req)}`,
});
// Starting a copy queues work on another platform.
const startLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 4,
  message: 'The copy was started several times just now. Wait a few minutes.',
  keyFn: (req) => `mirror-start|${platformActionKey(req)}`,
});
// The list of the person's Fluxer servers reads each one's roles; it is asked for when the page opens.
const listLimit = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: 'The list of Fluxer servers was asked for too often. Wait a minute.',
  keyFn: (req) => `mirror-servers|${platformActionKey(req)}`,
});
const controlLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyFn: (req) => `mirror-control|${platformActionKey(req)}`,
});

/** The pair this server is part of, with which side it is, or null. */
async function pairOf(req) {
  const key = req.guild.id;
  const pair = (await pairsOfGuild(key))[0] ?? null;
  if (!pair) return null;
  return { pair, side: pair.sourceGuild === key ? 'source' : 'target' };
}

/** The person's id on a server's platform ('' in open mode, where there are no accounts). */
const userIdOn = (req, key) => userIdForGuild(req, key) ?? '';

/** Answer 403 unless the signed-in person is the owner of this server. Returns their id there, or null. */
function needOwner(req, res, what) {
  if (!isGuildOwner(req, req.guild.id)) {
    fail(res, `Only the server owner can ${what}.`, 403, { code: 'owner-only' });
    return null;
  }
  return { userId: userIdOn(req, req.guild.id) };
}

/** What the page needs to know about a pair, for the side that is looking. Never a code, a hash or a secret. */
function pairView(pair, side) {
  const otherKey = side === 'source' ? pair.targetGuild : pair.sourceGuild;
  const other = guildByKey(otherKey);
  // The Discord side learns the Fluxer server's name only once someone there has agreed.
  const showName = side === 'target' || Boolean(pair.targetConsentBy);
  return {
    id: pair.id,
    side,
    status: pair.status,
    resumeStatus: pair.resumeStatus,
    options: normaliseOptions(pair.options),
    otherId: otherKey,
    otherName: showName ? (other?.name ?? null) : null,
    otherPresent: Boolean(other),
    // A dashboard user's name is shown only on their own server, never to the other server's viewers.
    requestedBy: side === 'source' ? pair.requestedBy : '',
    consent: {
      source: pair.sourceConsentBy
        ? { by: side === 'source' ? pair.sourceConsentBy : '', at: pair.sourceConsentAt }
        : null,
      target: pair.targetConsentBy
        ? { by: side === 'target' ? pair.targetConsentBy : '', at: pair.targetConsentAt }
        : null,
    },
    pauseKind: pair.status === PAIR_STATUS.PAUSED ? pair.pauseKind : '',
    pausedBy: pair.status === PAIR_STATUS.PAUSED ? pair.pausedBy : '',
    codeExpiresAt: pair.status === PAIR_STATUS.PENDING ? pair.codeExpiresAt : 0,
    lastError: pair.lastError,
    copiedAt: pair.copiedAt,
    copyRun: pair.copyRun,
    createdAt: pair.createdAt,
  };
}

async function stateOf(req) {
  const platform = platformOfGuild(req.guild);
  const found = await pairOf(req);
  return {
    platform,
    canMirror: platform === 'discord',
    fluxerConnected: config.fluxerEnabled,
    // Only the server owner can change anything here; everyone with access can look.
    isOwner: isGuildOwner(req, req.guild.id),
    pair: found ? pairView(found.pair, found.side) : null,
    progress: found ? await mirror.progress(found.pair) : null,
    defaults: DEFAULT_OPTIONS,
    limits: { emoji: FLUXER_LIMITS.emoji, stickers: FLUXER_LIMITS.stickers },
    // Mirror is a beta page (BETA_PAGES in registry.js): the page and the Sylo app show the same Beta mark.
    beta: isBeta('mirror'),
  };
}

router.get(
  '/mirror',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await stateOf(req));
  })
);

/** How many of a person's Fluxer servers the list names at most. */
const MAX_FLUXER_CHOICES = 100;

/**
 * What the picker says about one Fluxer server, checked as the preview checks it (src/mirror/engine.js): Sylo's role
 * needs Administrator there (or the four permissions the copy uses) and has to be the highest role. These are
 * notes, not blockers: the preview is where they stop a copy.
 */
async function choiceOf(key, guild) {
  const notes = [];
  try {
    const target = createFluxerTarget(guild);
    if (target.missingPermissions().length) {
      notes.push({
        code: 'target-permissions',
        message: "Sylo's role needs the Administrator permission on this server.",
      });
    }
    const above = target.rolesAboveSylo([]);
    if (above === null) {
      notes.push({ code: 'role-hierarchy', message: "Sylo's own role on this server could not be read." });
    } else if (above.length > 0) {
      notes.push({
        code: 'role-hierarchy',
        message: `Sylo's role is not the highest on this server (${above.length} ${above.length === 1 ? 'role ranks' : 'roles rank'} above or level with it). Drag it to the top under Server Settings, then Roles.`,
      });
    }
  } catch {
    notes.push({ code: 'unreadable', message: 'Sylo could not read the roles on this server just now.' });
  }
  const busy = (await pairsOfGuild(key)).length > 0;
  const members = Number(guild.memberCount ?? guild.members?.cache?.size ?? 0);
  return {
    id: key,
    name: String(guild.name ?? key),
    icon: guild.iconURL?.({ size: 64 }) ?? null,
    memberCount: Number.isFinite(members) && members > 0 ? members : null,
    inUse: busy,
    notes,
  };
}

// The Fluxer servers to pick the mirror's target from: those Sylo is a member of and the signed-in person owns
// according to their own connected Fluxer login (the owner id Fluxer reports, never a list the browser sends). A
// server they do not own is never named. Only the owner of this Discord server may ask, as for the request itself.
router.get(
  '/mirror/fluxer-servers',
  listLimit,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (platformOfGuild(req.guild) !== 'discord') {
      return fail(res, 'Only a Discord server can be mirrored. Ask for the mirror on the Discord server.');
    }
    if (!needOwner(req, res, 'pick a Fluxer server for a mirror')) return;
    // Open mode has no logins, so there is no identity to look for (and every server counts as the caller's).
    const connected = !config.authEnabled || Boolean(identityFor(req.account, 'fluxer'));
    const servers = [];
    if (config.fluxerEnabled && connected) {
      const keys = [...adminGuildIds(req)]
        .filter((k) => splitPlatformGuildId(k)?.platform === 'fluxer')
        .filter((k) => isGuildOwner(req, k));
      for (const key of keys.slice(0, MAX_FLUXER_CHOICES)) {
        const guild = guildByKey(key);
        if (guild) servers.push(await choiceOf(key, guild));
      }
      servers.sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ fluxerConnected: config.fluxerEnabled, connected, servers });
  })
);

/** A raw Fluxer id, or "fluxer:<id>", as a key. Null when it is neither. */
function fluxerKeyOf(raw) {
  const text = String(raw ?? '').trim();
  const key = /^\d{17,20}$/.test(text) ? makePlatformGuildId('fluxer', text) : text;
  return splitPlatformGuildId(key)?.platform === 'fluxer' ? key : null;
}

const consentStatus = (err) =>
  ({ 'no-request': 404, expired: 410, 'wrong-code': 403, cancelled: 403, 'no-consent': 409 })[err.code] ??
  409;

// Ask for a mirror: the Discord server is the source, and only its owner can ask. When the same person also owns the
// Fluxer server, both sides agree at once; otherwise the answer carries a one-time code to give to its owner.
router.post(
  '/mirror/request',
  askLimit,
  asyncHandler(async (req, res) => {
    if (platformOfGuild(req.guild) !== 'discord') {
      return fail(res, 'Only a Discord server can be mirrored. Ask for the mirror on the Discord server.');
    }
    const owner = needOwner(req, res, 'ask for a mirror');
    if (!owner) return;
    const targetKey = fluxerKeyOf(req.body?.targetGuildId);
    if (!targetKey) return fail(res, 'Enter the id of the Fluxer server.');
    if (!guildByKey(targetKey)) {
      return fail(
        res,
        'Sylo is not in that Fluxer server. Invite Sylo there with the Administrator permission first.',
        404
      );
    }
    try {
      // The same person owns the Fluxer server too (their account has that login): both sides agree at once.
      const targetOwner = isGuildOwner(req, targetKey);
      const { pair, code } = await requestMirror({
        sourceGuild: req.guild.id,
        targetGuild: targetKey,
        actor: actor(req),
        sourceUser: owner.userId,
        targetUser: userIdOn(req, targetKey),
        targetOwner,
        options: req.body?.options,
      });
      await recordAudit(req.guild.id, {
        actor: actor(req),
        action: 'mirror:request',
        detail: targetOwner
          ? 'asked for a mirror to a Fluxer server (agreed on both sides)'
          : 'asked for a mirror to a Fluxer server',
      });
      if (targetOwner) {
        await recordAudit(targetKey, {
          actor: actor(req),
          action: 'mirror:agree',
          detail: 'agreed to be the mirror target',
        });
      }
      invalidateHealth(req.guild.id);
      res.json({ ...(await stateOf(req)), code, agreed: Boolean(pair.targetConsentBy) });
    } catch (err) {
      if (err instanceof ConsentError) return fail(res, err.message, 409, { code: err.code });
      throw err;
    }
  })
);

// The Fluxer side agrees with the code.
router.post(
  '/mirror/accept',
  askLimit,
  asyncHandler(async (req, res) => {
    if (platformOfGuild(req.guild) !== 'fluxer') {
      return fail(res, 'The code is entered on the Fluxer server that is asked to be the mirror.');
    }
    const owner = needOwner(req, res, 'agree to a mirror');
    if (!owner) return;
    try {
      await acceptMirror({
        targetGuild: req.guild.id,
        code: req.body?.code,
        actor: actor(req),
        userId: owner.userId,
      });
    } catch (err) {
      if (err instanceof ConsentError) return fail(res, err.message, consentStatus(err), { code: err.code });
      throw err;
    }
    const found = await pairOf(req);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'mirror:agree',
      detail: 'agreed to be the mirror target',
    });
    if (found) {
      await recordAudit(found.pair.sourceGuild, {
        actor: actor(req),
        action: 'mirror:agree',
        detail: 'the Fluxer server agreed to the mirror',
      });
      invalidateHealth(found.pair.sourceGuild);
    }
    invalidateHealth(req.guild.id);
    res.json(await stateOf(req));
  })
);

/** The pair of this (source) server, or an answer that says why not. */
async function sourcePair(req, res, { needConsent = false } = {}) {
  const found = await pairOf(req);
  if (!found || found.side !== 'source') {
    fail(res, 'This server has no mirror to a Fluxer server. Ask for one first.', 404);
    return null;
  }
  if (needConsent && !(found.pair.sourceConsentBy && found.pair.targetConsentBy)) {
    fail(res, 'Both servers have to agree first.', 409, { code: 'no-consent' });
    return null;
  }
  return found.pair;
}

router.post(
  '/mirror/options',
  controlLimit,
  asyncHandler(async (req, res) => {
    if (!needOwner(req, res, 'change what is mirrored')) return;
    const pair = await sourcePair(req, res);
    if (!pair) return;
    const options = normaliseOptions({ ...pair.options, ...req.body });
    // Real deletion on Fluxer takes the owner of the Fluxer server: from here it can only be asked for, never switched
    // on (POST /mirror/deletes on the Fluxer server does that). Switching it off is always allowed.
    if (req.body?.mirrorDeletes === true) {
      options.mirrorDeletes = pair.options?.mirrorDeletes === true;
      options.mirrorDeletesRequested = true;
    } else if (req.body?.mirrorDeletes === false) {
      options.mirrorDeletes = false;
      options.mirrorDeletesRequested = false;
    } else {
      options.mirrorDeletes = pair.options?.mirrorDeletes === true;
    }
    if (req.body?.mirrorDeletesRequested === undefined && req.body?.mirrorDeletes === undefined) {
      options.mirrorDeletesRequested = pair.options?.mirrorDeletesRequested === true;
    }
    await updatePair(pair.id, { options });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'mirror:options',
      detail: 'mirror options changed',
    });
    res.json(await stateOf(req));
  })
);

// The owner of the Fluxer server allows (or stops) real deletion: only after the Discord side asked for it, and
// only from the Fluxer server's own page.
router.post(
  '/mirror/deletes',
  controlLimit,
  asyncHandler(async (req, res) => {
    if (!needOwner(req, res, 'allow deleting on this server')) return;
    const found = await pairOf(req);
    if (!found || found.side !== 'target') {
      return fail(res, 'This server is not the target of a mirror.', 404);
    }
    const options = normaliseOptions(found.pair.options);
    if (req.body?.allow === true) {
      if (!options.mirrorDeletesRequested) {
        return fail(res, 'The Discord server has not asked for deletions to be mirrored.', 409);
      }
      options.mirrorDeletes = true;
    } else {
      options.mirrorDeletes = false;
      options.mirrorDeletesRequested = false;
    }
    await updatePair(found.pair.id, { options });
    for (const key of [found.pair.sourceGuild, found.pair.targetGuild]) {
      await recordAudit(key, {
        actor: actor(req),
        action: 'mirror:deletes',
        detail: options.mirrorDeletes
          ? 'deleting on Fluxer was allowed'
          : 'deleting on Fluxer was switched off',
      });
    }
    res.json(await stateOf(req));
  })
);

// The dry run: what a copy would do now, and everything that cannot be carried over. Creates nothing.
router.get(
  '/mirror/preview',
  previewLimit,
  asyncHandler(async (req, res) => {
    const pair = await sourcePair(req, res, { needConsent: true });
    if (!pair) return;
    const preview = await mirror.previewPair(pair);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: preview.ok,
      blockers: preview.blockers,
      warnings: preview.warnings,
      summary: preview.summary,
      notes: preview.notes,
      target: preview.target,
      steps: preview.steps.map((s) => ({
        key: s.key,
        kind: s.kind,
        name: s.name,
        op: s.op,
        reason: s.reason ?? null,
        notes: (s.notes ?? []).length,
      })),
    });
  })
);

// What became of the latest copy, step by step.
router.get(
  '/mirror/report',
  asyncHandler(async (req, res) => {
    const pair = await sourcePair(req, res);
    if (!pair) return;
    res.set('Cache-Control', 'no-store');
    res.json(await mirror.report(pair));
  })
);

router.post(
  '/mirror/start',
  startLimit,
  asyncHandler(async (req, res) => {
    if (!needOwner(req, res, 'start a copy')) return;
    const pair = await sourcePair(req, res, { needConsent: true });
    if (!pair) return;
    if (req.body?.confirm !== true) return fail(res, 'Confirm the copy first.', 400);
    try {
      await mirror.startCopy(pair.id);
    } catch (err) {
      if (err instanceof ConsentError) return fail(res, err.message, 409, { code: err.code });
      if (err instanceof MirrorError) return fail(res, err.message, 409);
      throw err;
    }
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'mirror:start',
      detail: 'started copying to the Fluxer server',
    });
    await recordAudit(pair.targetGuild, {
      actor: actor(req),
      action: 'mirror:start',
      detail: 'a copy from the Discord server started',
    });
    res.json(await stateOf(req));
  })
);

/**
 * Pause, resume, stop and remove, from either server of the pair, by that server's owner. A mirror its owner paused
 * can be resumed only from the same side; after a burst of deletes the owner has to confirm them (`confirm: true`).
 */
function control(name, run, detail) {
  router.post(
    `/mirror/${name}`,
    controlLimit,
    asyncHandler(async (req, res) => {
      if (!needOwner(req, res, `${name} a mirror`)) return;
      const found = await pairOf(req);
      if (!found) return fail(res, 'This server has no mirror.', 404);
      try {
        await run(found.pair, found.side, req.body);
      } catch (err) {
        if (err instanceof MirrorError || err instanceof ConsentError) {
          return fail(res, err.message, 409, {
            ...(err.code ? { code: err.code } : {}),
            ...(err.deletes
              ? { deletes: err.deletes, deleteCount: err.deleteCount ?? err.deletes.length }
              : {}),
          });
        }
        throw err;
      }
      for (const key of [found.pair.sourceGuild, found.pair.targetGuild]) {
        await recordAudit(key, { actor: actor(req), action: `mirror:${name}`, detail });
      }
      res.json(await stateOf(req));
    })
  );
}
control('pause', (pair, side) => mirror.pause(pair.id, side), 'mirror paused');
control(
  'resume',
  (pair, side, body) => mirror.resume(pair.id, { side, confirm: body?.confirm === true }),
  'mirror resumed'
);
control('stop', (pair) => mirror.stopPair(pair.id), 'mirror stopped');
control('remove', (pair, side) => mirror.removePair(pair.id, side), 'mirror removed');

export default router;
