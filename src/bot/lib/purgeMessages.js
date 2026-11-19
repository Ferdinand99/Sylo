// The engine behind /purge: split a set of messages by age, bulk-delete what the platform
// allows, delete the rest one by one at a pace the platform accepts, and report what happened.
//
//   Discord: the bulk route takes 2-100 messages younger than 14 days. Older ones can only be
//            deleted one at a time (Discord throttles those to roughly one per second per channel).
//   Fluxer:  the bulk-delete route (fluxer_api, MessageDeleteService.bulkDeleteMessages) takes
//            1-100 ids of any age, so everything goes through the bulk route. Only the single
//            delete is rate limited there (20 per 10 s per channel), and it is the fallback.
//
// Both SDKs wait out a 429 themselves; this loop also catches the 429 that comes out of them
// (retries exhausted) and waits `retry_after` before trying that message again.
import { platformOfGuild } from '../../platform/platformOf.js';

const DISCORD_EPOCH = 1420070400000n;
const DAY_MS = 86_400_000;

/** Discord refuses a bulk delete that contains a message 14 days old; keep a margin for clock skew. */
export const BULK_MAX_AGE_MS = 14 * DAY_MS - 5 * 60_000;
/** The most messages one /purge touches (the command's `amount` maximum). */
export const PURGE_CAP = 100;
/** Pause between single deletes, per platform (Discord ~1/s for old messages, Fluxer 20 per 10 s). */
export const SINGLE_DELETE_PACE_MS = { discord: 1100, fluxer: 550 };
/** Retries of one message after a 429, and the longest wait we accept for one. */
export const MAX_RATE_LIMIT_RETRIES = 5;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 60_000;
const DEFAULT_RETRY_MS = 2_000;
/** A purge gives up after this long (a Discord interaction token lives 15 minutes). */
export const MAX_RUN_MS = 10 * 60_000;

/** When a message was created, from its snowflake id (falls back to the SDK's timestamp). */
export function messageTimestamp(message) {
  const id = String(message?.id ?? '');
  if (/^\d{15,20}$/.test(id)) return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  return Number.isFinite(message?.createdTimestamp) ? message.createdTimestamp : null;
}

/**
 * Split messages into those the bulk route accepts (younger than 14 days) and the rest. A message
 * whose age is unknown goes to `old`: a single delete always works.
 * @returns {{ recent: any[], old: any[] }}
 */
export function splitByAge(messages, now = Date.now()) {
  const recent = [];
  const old = [];
  for (const m of messages) {
    const ts = messageTimestamp(m);
    (ts != null && now - ts < BULK_MAX_AGE_MS ? recent : old).push(m);
  }
  return { recent, old };
}

// --- error classification --------------------------------------------------------

const statusOf = (err) => err?.status ?? err?.statusCode ?? err?.httpStatus ?? err?.rawError?.status;
const codeOf = (err) => err?.code ?? err?.rawError?.code;

export function isRateLimit(err) {
  return statusOf(err) === 429 || err?.name === 'RateLimitError' || err?.code === 'RATE_LIMITED';
}

/** How long a 429 asks us to wait, in ms. discord.js: `timeToReset` (ms); the API body and Fluxer: seconds. */
export function retryAfterMs(err) {
  let ms;
  if (Number.isFinite(err?.timeToReset)) ms = err.timeToReset;
  else {
    const secs = [err?.retry_after, err?.retryAfter, err?.rawError?.retry_after, err?.body?.retry_after].find(
      (v) => Number.isFinite(v)
    );
    ms = secs == null ? DEFAULT_RETRY_MS : secs * 1000;
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(ms)));
}

/** @returns {'gone' | 'permission' | 'tooOld' | 'other'} */
export function classifyError(err) {
  const status = statusOf(err);
  const code = codeOf(err);
  if (code === 50034) return 'tooOld'; // Discord: "can only bulk delete messages under 14 days old"
  if (code === 10008 || code === 'UNKNOWN_MESSAGE' || status === 404) return 'gone';
  if (
    code === 50013 ||
    code === 50001 ||
    code === 'MISSING_PERMISSIONS' ||
    code === 'MISSING_ACCESS' ||
    status === 403
  )
    return 'permission';
  return 'other';
}

// --- one purge at a time per channel -------------------------------------------------

/** @type {Map<string, { userId: string, startedAt: number }>} */
const running = new Map();

/**
 * Take the channel's purge lock. Returns a release function, or null when a purge is already
 * running there. `key` is `guildKey(guild):channelId`.
 */
export function acquirePurgeLock(key, userId) {
  if (running.has(key)) return null;
  const entry = { userId, startedAt: Date.now() };
  running.set(key, entry);
  return () => {
    if (running.get(key) === entry) running.delete(key);
  };
}

export const purgeLockHolder = (key) => running.get(key) ?? null;

/** Test seam. */
export function _resetPurgeLocks() {
  running.clear();
}

/** May `member` press Stop on a purge started by `starterId`? The starter and server admins (incl. the owner). */
export function canStopPurge({ userId, starterId, permissions, administrator }) {
  if (userId === starterId) return true;
  return Boolean(permissions?.has?.(administrator));
}

// --- the purge itself ----------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: the wait between single deletes. */
export const purgeTuning = { sleep: delay };

const emptyFailures = () => ({ gone: 0, permission: 0, other: 0 });

/**
 * Delete `messages` from `channel`.
 *
 * @param {any} channel
 * @param {any[]} messages  at most PURGE_CAP are touched
 * @param {object} [opts]
 * @param {'discord'|'fluxer'} [opts.platform]  default: the channel's guild's platform
 * @param {() => boolean} [opts.isStopped]      polled between deletes; true ends the run early
 * @param {(p: { deleted: number, failed: number, total: number }) => void} [opts.onProgress]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {number} [opts.paceMs]
 * @returns {Promise<{ total: number, deleted: number, failed: number,
 *   failures: { gone: number, permission: number, other: number }, stopped: boolean, remaining: number,
 *   bulk: number, single: number }>}
 */
export async function purgeMessages(channel, messages, opts = {}) {
  const platform = opts.platform ?? platformOfGuild(channel.guild);
  const sleep = opts.sleep ?? purgeTuning.sleep;
  const now = opts.now ?? Date.now;
  const paceMs = opts.paceMs ?? SINGLE_DELETE_PACE_MS[platform] ?? SINGLE_DELETE_PACE_MS.discord;
  const isStopped = opts.isStopped ?? (() => false);
  const startedAt = now();

  const targets = [...messages].slice(0, PURGE_CAP);
  const total = targets.length;
  const failures = emptyFailures();
  const result = { total, deleted: 0, failed: 0, failures, stopped: false, remaining: 0, bulk: 0, single: 0 };

  const progress = () => opts.onProgress?.({ deleted: result.deleted, failed: result.failed, total });
  const fail = (kind, n = 1) => {
    failures[kind === 'tooOld' ? 'other' : kind] += n;
    result.failed += n;
  };

  // Which messages go through the bulk route. Fluxer takes any age and a single id; Discord needs 2-100
  // under 14 days (a lone recent message is deleted like an old one).
  let bulkable;
  let singles;
  if (platform === 'fluxer') {
    bulkable = targets;
    singles = [];
  } else {
    const { recent, old } = splitByAge(targets, now());
    bulkable = recent.length >= 2 ? recent : [];
    singles = recent.length >= 2 ? old : [...recent, ...old];
  }

  // 1. Bulk.
  if (bulkable.length && !isStopped()) {
    try {
      const done = await channel.bulkDelete(bulkable, platform !== 'fluxer');
      const n = done?.size ?? done?.length ?? bulkable.length;
      result.deleted += n;
      result.bulk += n;
      if (n < bulkable.length) {
        // The SDK skipped some (for example a message that just turned 14 days old): delete those singly.
        const doneIds = new Set(done instanceof Map ? done.keys() : (done ?? []).map((d) => d?.id ?? d));
        singles = [...bulkable.filter((m) => !doneIds.has(m.id)), ...singles];
      }
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'permission') fail('permission', bulkable.length);
      else singles = [...bulkable, ...singles]; // too old, a hiccup, anything else: one by one, each is classified
    }
    progress();
  } else if (bulkable.length) {
    singles = [...bulkable, ...singles];
  }

  // 2. One by one, paced.
  for (let i = 0; i < singles.length; i++) {
    if (isStopped()) {
      result.stopped = true;
      result.remaining = singles.length - i;
      break;
    }
    if (now() - startedAt > MAX_RUN_MS) {
      result.stopped = true;
      result.remaining = singles.length - i;
      break;
    }
    if (i > 0) await sleep(paceMs);
    if (isStopped()) {
      result.stopped = true;
      result.remaining = singles.length - i;
      break;
    }
    const message = singles[i];
    let attempt = 0;
    for (;;) {
      try {
        await message.delete();
        result.deleted += 1;
        result.single += 1;
        break;
      } catch (err) {
        if (isRateLimit(err) && attempt < MAX_RATE_LIMIT_RETRIES && !isStopped()) {
          attempt += 1;
          await sleep(retryAfterMs(err));
          continue;
        }
        fail(isRateLimit(err) ? 'other' : classifyError(err));
        break;
      }
    }
    progress();
  }

  return result;
}
