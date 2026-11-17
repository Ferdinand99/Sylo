// Consent for a mirror: nothing is created on the Fluxer server until the owner of each server has agreed. Only a
// server's owner can (src/web/lib/guildOwner.js): not an Administrator, not a dashboard Edit holder, not a bot master.
// The Discord owner agrees by asking. The Fluxer owner agrees in one of two ways:
//   - the same person owns both servers (their account has both logins): both sides agree at once;
//   - otherwise the request carries a one-time code. The Fluxer server's owner opens the dashboard there and enters
//     it. The code expires after 15 minutes, is stored only as a hash, and five wrong tries cancel the request.
// The owners' platform user ids are kept with the agreement, and the engine checks them again before every piece of
// work (ownership.js): a server that changes hands pauses the mirror until the new owner confirms.
//
// Everything that wants to know whether a mirror may go ahead asks requirePairConsent(). It asks the current
// consent provider, so the check can later be replaced by the bridge's own link codes (setConsentProvider)
// without touching the engine or the routes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PAIR_STATUS,
  createPair,
  deletePair,
  getPair,
  getPairBySource,
  getPairByTarget,
  countMappings,
  updatePair,
} from '../db/mirror.js';
import { normaliseOptions } from './spec.js';

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

export class ConsentError extends Error {
  /** @param {string} message @param {string} code a short machine-readable reason */
  constructor(message, code) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
  }
}

// No 0, O, 1, I or L: a code is read aloud or typed from a screenshot.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A new code like "K7QW-H2NP". */
export function newCode() {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

const normaliseCode = (code) =>
  String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
const hashCode = (pairKey, code) =>
  createHash('sha256')
    .update(`${pairKey}|${normaliseCode(code)}`)
    .digest('hex');
const pairKey = (source, target) => `${source}>${target}`;

/**
 * The consent provider: given a pair, may a mirror run? The default checks the two agreements the pair
 * records. A replacement (the bridge's link codes) has the same shape.
 * @type {{ name: string, check: (pair: any) => Promise<{ ok: boolean, reason?: string }> | { ok: boolean, reason?: string } }}
 */
const codeProvider = {
  name: 'mirror-code',
  check(pair) {
    if (!pair) return { ok: false, reason: 'There is no such mirror.' };
    if (!pair.sourceConsentBy) return { ok: false, reason: 'Nobody has agreed on the Discord server yet.' };
    if (!pair.targetConsentBy) return { ok: false, reason: 'Nobody has agreed on the Fluxer server yet.' };
    return { ok: true };
  },
};

let provider = codeProvider;

/** Swap the consent check (the bridge's link codes can reuse the same shape). Returns the one replaced. */
export function setConsentProvider(next) {
  const previous = provider;
  provider = next ?? codeProvider;
  return previous;
}

/**
 * Throws a ConsentError unless both servers have agreed to this mirror. Returns the pair.
 * @param {number | any} pairOrId
 */
export async function requirePairConsent(pairOrId) {
  const pair = typeof pairOrId === 'object' ? pairOrId : await getPair(Number(pairOrId));
  const verdict = await provider.check(pair);
  if (!verdict.ok)
    throw new ConsentError(verdict.reason ?? 'Both servers have to agree first.', 'no-consent');
  return pair;
}

/**
 * The options of a request. Real deletion on Fluxer only takes effect when the same person owns both servers; for
 * anyone else it is kept as a request that the owner of the Fluxer server has to turn on with their own switch.
 */
function askedOptions(options, targetOwner) {
  const out = normaliseOptions(options);
  if (out.mirrorDeletes || out.mirrorDeletesRequested) {
    out.mirrorDeletesRequested = true;
    out.mirrorDeletes = Boolean(targetOwner) && out.mirrorDeletes;
  }
  return out;
}

/**
 * The options a new request keeps when it brings none of its own. Real deletion on Fluxer is the Fluxer owner's own
 * switch, so it is kept only when the same person who switched it on (the Fluxer owner recorded on the pair) now owns
 * both servers; a new Fluxer owner, or a request from someone who is not the Fluxer owner, starts with it off (the
 * request for it stays, so the owner can switch it on themselves).
 */
function inheritedOptions(pair, targetOwner, targetUser) {
  const out = normaliseOptions(pair.options);
  out.mirrorDeletes =
    out.mirrorDeletes &&
    Boolean(targetOwner) &&
    Boolean(pair.targetConsentUser) &&
    pair.targetConsentUser === targetUser;
  return out;
}

/** A pair that has never copied anything may be replaced by a new request; one that has, may not. */
const replaceable = (pair) =>
  pair.status === PAIR_STATUS.PENDING ||
  pair.status === PAIR_STATUS.READY ||
  pair.status === PAIR_STATUS.STOPPED;

/**
 * Ask for a mirror of a Discord server onto a Fluxer server. The caller has checked that the actor is the owner of
 * the Discord server and that Sylo is in both servers; `targetOwner` says whether the same person also owns the
 * Fluxer server. `sourceUser` and `targetUser` are the owners' platform user ids, kept so the engine can tell when
 * a server changes hands.
 * @param {{ sourceGuild: string, targetGuild: string, actor: string, sourceUser?: string, targetUser?: string, targetOwner: boolean, options?: object, now?: number }} p
 * @returns {Promise<{ pair: any, code: string | null }>} `code` is shown once, only when the Fluxer side still has to agree
 */
export async function requestMirror({
  sourceGuild,
  targetGuild,
  actor,
  sourceUser = '',
  targetUser = '',
  targetOwner,
  options,
  now = Date.now(),
}) {
  if (sourceGuild === targetGuild)
    throw new ConsentError('A server cannot be mirrored onto itself.', 'same-server');

  const bySource = await getPairBySource(sourceGuild);
  if (bySource && (bySource.targetGuild !== targetGuild || !replaceable(bySource))) {
    if (!replaceable(bySource)) {
      throw new ConsentError('This server is already mirrored. Stop that mirror first.', 'already-mirrored');
    }
    await deletePair(bySource.id);
  }
  const byTarget = await getPairByTarget(targetGuild);
  if (byTarget && byTarget.sourceGuild !== sourceGuild) {
    const stale = byTarget.status === PAIR_STATUS.PENDING && byTarget.codeExpiresAt < now;
    if (!stale && !replaceable(byTarget)) {
      throw new ConsentError('That Fluxer server is already the target of another mirror.', 'target-busy');
    }
    if (!stale && byTarget.status !== PAIR_STATUS.STOPPED) {
      throw new ConsentError('Another server has a pending request for that Fluxer server.', 'target-busy');
    }
    // A stopped mirror that made something keeps its id map: the items it made stay known as Sylo's own.
    if (!stale && (await countMappings(byTarget.id)) > 0) {
      throw new ConsentError(
        'That Fluxer server was the target of a mirror that made things there. Remove that mirror first.',
        'target-busy'
      );
    }
    await deletePair(byTarget.id);
  }

  let pair = await getPairBySource(sourceGuild);
  const code = targetOwner ? null : newCode();
  const fields = {
    status: targetOwner ? PAIR_STATUS.READY : PAIR_STATUS.PENDING,
    requestedBy: actor,
    sourceConsentBy: actor,
    sourceConsentAt: now,
    sourceConsentUser: sourceUser,
    targetConsentBy: targetOwner ? actor : '',
    targetConsentAt: targetOwner ? now : 0,
    targetConsentUser: targetOwner ? targetUser : '',
    pauseKind: '',
    pausedBy: '',
    codeHash: code ? hashCode(pairKey(sourceGuild, targetGuild), code) : '',
    codeExpiresAt: code ? now + CODE_TTL_MS : 0,
    codeAttempts: 0,
    lastError: '',
    failures: 0,
    ...(options
      ? { options: askedOptions(options, targetOwner) }
      : pair
        ? { options: inheritedOptions(pair, targetOwner, targetUser) }
        : {}),
  };
  if (pair) {
    pair = await updatePair(pair.id, fields, now);
  } else {
    pair = await createPair({ sourceGuild, targetGuild, options: askedOptions(options, targetOwner), now });
    pair = await updatePair(pair.id, fields, now);
  }
  return { pair, code };
}

/**
 * The owner of the Fluxer server agrees, with the code the request showed. Looks only at the pair
 * whose target is `targetGuild`, so a code cannot be used for another server.
 * @param {{ targetGuild: string, code: string, actor: string, userId?: string, now?: number }} p
 */
export async function acceptMirror({ targetGuild, code, actor, userId = '', now = Date.now() }) {
  const pair = await getPairByTarget(targetGuild);
  if (!pair || pair.status !== PAIR_STATUS.PENDING || !pair.codeHash) {
    throw new ConsentError('There is no request waiting for this server.', 'no-request');
  }
  if (pair.codeExpiresAt < now) {
    await deletePair(pair.id);
    throw new ConsentError('The code has expired. Ask for a new one on the Discord server.', 'expired');
  }
  const given = Buffer.from(hashCode(pairKey(pair.sourceGuild, pair.targetGuild), code), 'hex');
  const want = Buffer.from(pair.codeHash, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    const attempts = pair.codeAttempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await deletePair(pair.id);
      throw new ConsentError(
        'Too many wrong codes. The request is cancelled; ask for a new one.',
        'cancelled'
      );
    }
    await updatePair(pair.id, { codeAttempts: attempts }, now);
    throw new ConsentError('That code is not right.', 'wrong-code');
  }
  const next = await updatePair(
    pair.id,
    {
      status: PAIR_STATUS.READY,
      targetConsentBy: actor,
      targetConsentAt: now,
      targetConsentUser: userId,
      codeHash: '',
      codeExpiresAt: 0,
      codeAttempts: 0,
    },
    now
  );
  return next;
}
