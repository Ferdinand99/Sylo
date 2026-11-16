// Consent for a mirror: nothing is created on the Fluxer server until someone with Edit access on each side
// has agreed. The Discord side agrees by asking (the person asking holds Edit there: the route is Edit-only).
// The Fluxer side agrees in one of two ways:
//   - the same person also holds Edit on the Fluxer server (their account has the Fluxer login): both sides
//     agree at once;
//   - otherwise the request carries a one-time code. Someone with Edit on the Fluxer server opens the
//     dashboard there and enters it. The code expires after an hour, is stored only as a hash, and five wrong
//     tries cancel the request.
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
  updatePair,
} from '../db/mirror.js';
import { normaliseOptions } from './spec.js';

export const CODE_TTL_MS = 60 * 60_000;
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

/** A pair that has never copied anything may be replaced by a new request; one that has, may not. */
const replaceable = (pair) =>
  pair.status === PAIR_STATUS.PENDING ||
  pair.status === PAIR_STATUS.READY ||
  pair.status === PAIR_STATUS.STOPPED;

/**
 * Ask for a mirror of a Discord server onto a Fluxer server. The caller has checked that the actor holds
 * Edit on the source and that Sylo is in both servers; `targetEdit` says whether the same person also holds
 * Edit on the Fluxer server.
 * @param {{ sourceGuild: string, targetGuild: string, actor: string, targetEdit: boolean, options?: object, now?: number }} p
 * @returns {Promise<{ pair: any, code: string | null }>} `code` is shown once, only when the Fluxer side still has to agree
 */
export async function requestMirror({
  sourceGuild,
  targetGuild,
  actor,
  targetEdit,
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
    await deletePair(byTarget.id);
  }

  let pair = await getPairBySource(sourceGuild);
  const code = targetEdit ? null : newCode();
  const fields = {
    status: targetEdit ? PAIR_STATUS.READY : PAIR_STATUS.PENDING,
    requestedBy: actor,
    sourceConsentBy: actor,
    sourceConsentAt: now,
    targetConsentBy: targetEdit ? actor : '',
    targetConsentAt: targetEdit ? now : 0,
    codeHash: code ? hashCode(pairKey(sourceGuild, targetGuild), code) : '',
    codeExpiresAt: code ? now + CODE_TTL_MS : 0,
    codeAttempts: 0,
    lastError: '',
    failures: 0,
    ...(options ? { options: normaliseOptions(options) } : {}),
  };
  if (pair) {
    pair = await updatePair(pair.id, fields, now);
  } else {
    pair = await createPair({ sourceGuild, targetGuild, options: normaliseOptions(options), now });
    pair = await updatePair(pair.id, fields, now);
  }
  return { pair, code };
}

/**
 * Someone with Edit on the Fluxer server agrees, with the code the request showed. Looks only at the pair
 * whose target is `targetGuild`, so a code cannot be used for another server.
 * @param {{ targetGuild: string, code: string, actor: string, now?: number }} p
 */
export async function acceptMirror({ targetGuild, code, actor, now = Date.now() }) {
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
      codeHash: '',
      codeExpiresAt: 0,
      codeAttempts: 0,
    },
    now
  );
  return next;
}
