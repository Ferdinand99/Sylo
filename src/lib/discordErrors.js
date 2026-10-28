// Helpers for the Discord API errors that are noise rather than bugs, and for logging an
// unhandled rejection in a way that can be diagnosed afterwards.
import { log } from './log.js';

/** Discord error codes for an interaction that can no longer be answered. */
export const UNKNOWN_INTERACTION = 10062; // the 3 s (or 15 min follow-up) window has passed
export const ALREADY_ACKNOWLEDGED = 40060; // someone already replied / deferred

/**
 * True for the "too late" and "already answered" errors of an interaction response. They
 * say nothing about our code: the user clicked after the token expired, or two paths replied.
 */
export function isStaleInteractionError(err) {
  return err?.code === UNKNOWN_INTERACTION || err?.code === ALREADY_ACKNOWLEDGED;
}

/**
 * Run an interaction response (`i.update(...)`, `i.reply(...)`) and swallow the stale
 * interaction errors; anything else is logged under `scope` and still swallowed, because the
 * caller is a fire-and-forget listener with nobody to catch it.
 * @returns {Promise<boolean>} whether the response went through
 */
export async function respondSafely(scope, what, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (!isStaleInteractionError(err)) log.error(scope, `${what} failed:`, err);
    return false;
  }
}

/**
 * Path of a request URL with every secret removed: no query string, and the token segment of
 * the interaction callback (`/interactions/{id}/{token}/callback`) and webhook
 * (`/webhooks/{app}/{token}`) endpoints replaced. Returns '' for something that isn't a URL.
 */
export function redactedUrlPath(url) {
  if (typeof url !== 'string' || !url) return '';
  let path;
  try {
    path = new URL(url, 'https://discord.invalid').pathname;
  } catch {
    path = String(url).split(/[?#]/)[0];
  }
  return path.replace(/\/(interactions|webhooks)\/([^/]+)\/[^/]+/gi, '/$1/$2/<token>');
}

/**
 * A short, secret-free description of an API-style error (Discord, fetch): its class, code,
 * HTTP status, method and URL path. '' when the value carries none of them.
 */
export function describeApiError(reason) {
  if (!reason || typeof reason !== 'object') return '';
  const parts = [];
  if (reason.code !== undefined) parts.push(`code=${reason.code}`);
  if (reason.status !== undefined) parts.push(`status=${reason.status}`);
  const path = redactedUrlPath(reason.url);
  if (reason.method || path) parts.push([reason.method, path].filter(Boolean).join(' '));
  if (!parts.length) return '';
  const kind = reason.name && reason.name !== 'Error' ? `${reason.name} ` : '';
  return `[${kind}${parts.join(' ')}]`;
}

/** The first few stack frames on one line ('' when there is no stack), for the text log. */
function originOf(reason, frames = 4) {
  const stack = typeof reason?.stack === 'string' ? reason.stack : '';
  const at = stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, frames);
  return at.length ? `(${at.join(' < ')})` : '';
}

/**
 * The `unhandledRejection` handler: log it with enough detail to find where it came from. The
 * text log only prints a stack at debug level, so the API details and the top frames go into
 * the line itself; the Error is still passed on whole (JSON log, error report).
 */
export function logUnhandledRejection(reason) {
  const extra = [describeApiError(reason), originOf(reason)].filter(Boolean);
  log.error('sylo', 'Unhandled promise rejection', ...extra, reason);
}
