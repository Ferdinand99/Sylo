// Tiny structured logger — no dependencies. Configured from the environment
// when this module loads:
//
//   LOG_LEVEL   debug | info | warn | error        (default: info)
//   LOG_FORMAT  text | json                          (default: text)
//   LOG_JSON=1  shorthand for LOG_FORMAT=json
//
// Text:  2026-09-01T12:34:56.789Z  INFO  db  Backup written sylo-…db
// JSON:  {"ts":"2026-09-01T12:34:56.789Z","level":"info","scope":"db","msg":"…"}
//
// Usage: log.info('scope', 'message', extraStringOrObject, anErrorMaybe)
// An Error anywhere in the extra args is unwrapped (its message is appended, and
// its stack is shown at debug level / carried in JSON). `log.error(...)` also
// records the event in the /health error history via runtime.recordError.
import { recordError } from '../runtime.js';
import { inc } from './metrics.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const asJson =
  /^(1|true|yes|on)$/i.test(process.env.LOG_JSON || '') ||
  String(process.env.LOG_FORMAT || '').toLowerCase() === 'json';

/** Split trailing args into a text tail, an Error, and a plain-object meta bag. */
function splitArgs(args) {
  const parts = [];
  const meta = {};
  let err = null;
  for (const a of args) {
    if (a instanceof Error) err = a;
    else if (a && typeof a === 'object') Object.assign(meta, a);
    else if (a !== undefined) parts.push(String(a));
  }
  return { tail: parts.join(' '), err, meta };
}

function emit(level, scope, msg, args) {
  if (LEVELS[level] < threshold) return;
  const { tail, err, meta } = splitArgs(args);
  const message = [msg, tail].filter(Boolean).join(' ');
  const ts = new Date().toISOString();

  if (asJson) {
    const rec = { ts, level, scope: String(scope), msg: message, ...meta };
    if (err) rec.err = err.stack || String(err);
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(
      `${JSON.stringify(rec)}\n`
    );
  } else {
    const withErr = err?.message ? `${message} ${err.message}`.trim() : message;
    const line = `${ts}  ${level.toUpperCase().padEnd(5)} ${scope}  ${withErr}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    if (err?.stack && threshold <= LEVELS.debug) console.error(err.stack);
  }

  if (level === 'error') {
    try {
      recordError(err || new Error(message), String(scope));
      inc('sylo_errors_total', { scope: String(scope) });
    } catch {
      // runtime module not ready / unavailable — never let logging throw.
    }
  }
}

export const log = {
  debug: (scope, msg, ...a) => emit('debug', scope, msg, a),
  info: (scope, msg, ...a) => emit('info', scope, msg, a),
  warn: (scope, msg, ...a) => emit('warn', scope, msg, a),
  error: (scope, msg, ...a) => emit('error', scope, msg, a),
};
