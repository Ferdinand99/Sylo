// The bot's error reports, for the hosted Sylo. With BOT_ERROR_DSN set, everything logged
// with log.error (already stripped of secrets there) is also sent to that DSN as a Sentry
// envelope, which Keen Kestrel and Sentry both take, tagged with its log scope. No SDK: one
// POST per error over Node's fetch, at most MAX_PER_MINUTE a minute, pausing when the server
// says so (429). Without the DSN (every self-hosted instance, by default) nothing is sent.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { parseDsn } from '../web/lib/telemetry.js';

const { version } = createRequire(import.meta.url)('../../package.json');

/** The repository root: stack frames under it are Sylo's own code ("in app"). */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_PER_MINUTE = 30;
const MAX_CAUSES = 5;

/** @type {{ url: string, auth: string, environment: string, send: typeof fetch } | null} */
let target = null;
const pending = new Set();
let pausedUntil = 0;
let windowStart = 0;
let sentInWindow = 0;

/**
 * Start sending error reports when BOT_ERROR_DSN is set. Returns whether it did.
 * @param {{ dsn?: string | null, environment?: string, send?: typeof fetch }} [opts]
 */
export function startErrorReports({
  dsn = config.botErrorDsn,
  environment = config.errorEnvironment,
  send = fetch,
} = {}) {
  if (!dsn) return false;
  const parsed = parseDsn(dsn);
  if (!parsed) {
    console.error(
      '[config] BOT_ERROR_DSN is not a DSN (https://<public key>@<host>/<project id>); bot error reports are off.'
    );
    return false;
  }
  target = {
    url: parsed.envelope,
    auth: `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=sylo/${version}`,
    environment,
    send,
  };
  return true;
}

/**
 * A V8 stack as Sentry frames, oldest call first.
 * @param {string | undefined} stack
 */
export function parseStack(stack) {
  const frames = [];
  for (const line of String(stack ?? '').split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    let file = m[2];
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        // Keep it as it is.
      }
    }
    const ours = file.startsWith(ROOT) && !file.includes(`${sep}node_modules${sep}`);
    frames.push({
      filename: ours ? relative(ROOT, file).split(sep).join('/') : file,
      function: (m[1] ?? '<anonymous>').replace(/^async /, ''),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: ours,
    });
  }
  return frames.reverse();
}

/**
 * The Sentry event for `err` (and its causes) logged under `scope`.
 * @param {Error} err
 * @param {string} scope
 * @param {string} environment
 */
export function buildEvent(err, scope, environment) {
  const values = [];
  for (let e = err, n = 0; e instanceof Error && n < MAX_CAUSES; e = e.cause, n += 1) {
    values.push({
      type: e.name || 'Error',
      value: e.message,
      stacktrace: { frames: parseStack(e.stack) },
    });
  }
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    release: `sylo@${version}`,
    environment,
    tags: { component: 'bot', scope },
    // Sentry lists the oldest cause first and the error itself last.
    exception: { values: values.reverse() },
    contexts: { runtime: { name: 'node', version: process.version } },
  };
}

/**
 * Report one error (called by log.error). A no-op unless startErrorReports ran; never throws.
 * @param {Error} err
 * @param {string} scope
 */
export function reportError(err, scope) {
  if (!target) return;
  const now = Date.now();
  if (now < pausedUntil) return;
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_PER_MINUTE) return;
  sentInWindow += 1;
  try {
    const event = buildEvent(err, scope, target.environment);
    const body =
      `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n` +
      `${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    const { send, url, auth } = target;
    const request = send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (res.status === 429) {
          const wait = Number(res.headers.get('retry-after'));
          pausedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000;
        }
      })
      .catch(() => {
        // Not reachable: the error is in the log and /health either way.
      })
      .finally(() => pending.delete(request));
    pending.add(request);
  } catch {
    // Reporting must never break logging.
  }
}

/** Wait (at most `ms`) for reports on their way, before the process exits. */
export async function flushErrorReports(ms = 2000) {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, ms).unref())]);
}

/** For tests: stop and forget all state. */
export function stopErrorReports() {
  target = null;
  pending.clear();
  pausedUntil = 0;
  windowStart = 0;
  sentInWindow = 0;
}
