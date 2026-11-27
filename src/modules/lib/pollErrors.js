// Transient errors in the shared live-alert polls (Twitch and Kick).
//
// A poll asks a platform for every saved streamer at once, once a minute. A network blip (a reset
// connection, a DNS hiccup, a 502) should not page the operator, so:
//  - withRetry() repeats a failed request once after a short delay, for network errors, 5xx and
//    429 (honouring Retry-After). 4xx answers other than 429 are not retried: they mean the
//    request or a value in it is wrong, and asking again gives the same answer.
//  - createPollHealth() counts consecutive failed polls. One line (warn) after POLL_WARN_AFTER
//    failures in a row, one when polling works again, and a "still failing" reminder once an hour
//    while it lasts. Errors that are not network or HTTP problems (a TypeError in our own code, a
//    4xx that needs a fix such as bad credentials) are logged as errors the first time and when
//    the message changes, then once an hour ("still failing after N polls"): every error line
//    also feeds /health, the error counter and the error reports, so one bad secret must not
//    write 1440 of them a day.
// "fetch failed", Node's generic network error, hides the reason in `err.cause`; describeError()
// puts its code (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ...) in the text.
import { log } from '../../lib/log.js';

/** Failed polls in a row before one warning is logged. */
export const POLL_WARN_AFTER = 3;

/** How often a failure that goes on is logged again. */
export const STILL_FAILING_MS = 60 * 60_000;

/** Retry settings. An object so a test can shorten the wait; do not change it elsewhere. */
export const pollRetry = {
  delayMs: 3000,
  /** A longer Retry-After than this is not waited for: the poll fails and the next one tries again. */
  maxWaitMs: 15_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  // undici: connection and timeout problems only. The others (UND_ERR_INVALID_ARG, ...) are
  // faults in how we call it and must stay errors.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
  'UND_ERR_REQ_RETRY',
]);

/** The error, its causes, and the members of an AggregateError (a dual-stack connect failure). */
function chain(err) {
  const out = [];
  const queue = [err];
  while (queue.length > 0 && out.length < 8) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || out.includes(e)) continue;
    out.push(e);
    queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
  return out;
}

const isTimeoutName = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

/** The first string error code in the chain (ECONNRESET, UND_ERR_SOCKET, ...), or the timeout name. */
export function causeCode(err) {
  const items = chain(err);
  for (const e of items) if (typeof e.code === 'string' && e.code) return e.code;
  const named = items.find(isTimeoutName);
  return named ? named.name : null;
}

/** A failed request that never got an HTTP answer: connection, DNS, TLS, timeout, broken body. */
export function isNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.status === 'number') return false; // we got an answer
  const items = chain(err);
  if (items.some(isTimeoutName)) return true;
  // undici wraps every dispatcher error in TypeError('fetch failed', { cause }): when a cause
  // carries a code, the code decides (UND_ERR_INVALID_ARG is our fault, ECONNRESET is the network).
  const codes = items.map((e) => e.code).filter((c) => typeof c === 'string' && c);
  if (codes.length > 0) return codes.some((c) => NETWORK_CODES.has(c));
  // No code anywhere: the generic wrapper alone counts as a network failure.
  return items.some(
    (e) => e instanceof TypeError && (e.message === 'fetch failed' || e.message === 'terminated')
  );
}

/** 5xx and 429: the platform is busy or down, try again later. Other statuses are not transient. */
export function isTransientStatus(status) {
  return typeof status === 'number' && (status >= 500 || status === 429);
}

/** Retry once, wait a moment, and count on the next poll: network errors, 5xx and 429. */
export function isTransient(err) {
  return isNetworkError(err) || isTransientStatus(err?.status);
}

function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Twitch states when its rate limit resets, in epoch seconds. That says nothing about an
  // outage, so it is only read for a 429.
  if (res.status === 429) {
    const reset = Number(res.headers?.get?.('ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  }
  return null;
}

/**
 * The error for a non-OK answer: `${label} ${status}`, with `status`, and `retryAfterMs` when the
 * platform said how long to wait (429 and 503 only). The message holds no URL, so no credentials.
 */
export function httpError(label, res) {
  const err = new Error(`${label} ${res.status}`);
  err.status = res.status;
  if (res.status === 429 || res.status === 503) {
    const wait = retryAfterMs(res);
    if (wait !== null) err.retryAfterMs = wait;
  }
  return err;
}

/**
 * The error for a non-OK answer of the token endpoint. Its status is kept only when it is
 * transient (`httpStatus` always holds it): a refused token is a fault of the request, never of
 * one stored value, so batchIsolation's "rejected value" statuses (400, 404, 422) must not see it.
 */
export function tokenError(label, res) {
  const err = httpError(label, res);
  err.httpStatus = res.status;
  if (!isTransientStatus(res.status)) delete err.status;
  return err;
}

/**
 * Run `fn`; if it fails with a transient error, wait a moment and run it once more. An error with
 * `retryNow` (a 401 whose token was just cleared) is retried at once.
 */
export async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err) && !err?.retryNow) throw err;
    const wait = err.retryNow ? 0 : (err.retryAfterMs ?? pollRetry.delayMs);
    if (wait > pollRetry.maxWaitMs) throw err;
    await pollRetry.sleep(wait);
    return await fn();
  }
}

/** Short text for a log line: the message, plus the cause code when the message hides it. */
export function describeError(err) {
  const message = String(err?.message ?? err)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>') // never a URL, it may carry credentials
    .slice(0, 200);
  const code = causeCode(err);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/**
 * Counts consecutive failed polls of one platform.
 * @param {string} scope  the log scope, e.g. 'twitch-alerts'
 * @param {{ warnAfter?: number, repeatMs?: number, now?: () => number }} [o]
 */
export function createPollHealth(
  scope,
  { warnAfter = POLL_WARN_AFTER, repeatMs = STILL_FAILING_MS, now = () => Date.now() } = {}
) {
  let failures = 0; // transient failures in a row
  let warned = false;
  let warnedAt = 0;
  /**
   * The errors that are not transient and go on, by kind (name, status, message without numbers),
   * so errors that alternate, or whose message holds a changing value, are not logged every poll.
   * A fixed number of kinds is kept; the oldest is dropped.
   * @type {Map<string, { polls: number, loggedAt: number }>}
   */
  const faults = new Map();
  const MAX_KINDS = 10;
  const kindOf = (err) =>
    [err?.name, err?.httpStatus ?? err?.status ?? '', describeError(err).replace(/\d+/g, '#')].join('|');
  const faultPolls = () => [...faults.values()].reduce((sum, f) => sum + f.polls, 0);
  const reset = () => {
    failures = 0;
    warned = false;
    faults.clear();
  };
  return {
    /** Transient failed polls in a row. */
    get failures() {
      return failures;
    },
    /** A poll failed with `err`. Logs now, later or not at all, see the file head. */
    failed(err) {
      if (!isTransient(err)) {
        const kind = kindOf(err);
        const fault = faults.get(kind);
        if (!fault) {
          if (faults.size >= MAX_KINDS) faults.delete(faults.keys().next().value);
          faults.set(kind, { polls: 1, loggedAt: now() });
          log.error(scope, 'poll failed:', err); // the Error itself: its stack reaches the logs
          return;
        }
        fault.polls += 1;
        if (now() - fault.loggedAt >= repeatMs) {
          fault.loggedAt = now();
          log.error(scope, `poll still failing after ${fault.polls} polls: ${describeError(err)}`);
        }
        return;
      }
      failures += 1;
      if (failures === warnAfter) {
        warned = true;
        warnedAt = now();
        log.warn(
          scope,
          `poll failed ${failures} times in a row (${describeError(err)}); new streams may be announced late until it works again`
        );
      } else if (warned && now() - warnedAt >= repeatMs) {
        warnedAt = now();
        log.warn(scope, `poll still failing after ${failures} polls (${describeError(err)})`);
      }
    },
    /** A poll worked. */
    ok() {
      if (warned || faults.size > 0) {
        log.warn(scope, `polling works again after ${failures + faultPolls()} failed polls`);
      }
      reset();
    },
    reset,
  };
}
