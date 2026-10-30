// The client of Postal Pigeon, the Hedgerow push relay (https://pigeon.hedgerow.tools, its wire
// format is in the relay's docs/api.md). Sylo uses it to push to apps that registered a Pigeon
// handle: Pigeon builds a notification with no text in it, and the app fetches the text from
// Sylo (GET /api/mobile/push/events/:ref, src/web/routes/mobile.js).
//
// - Registration happens by itself the first time something is sent: fetch a challenge, solve
//   the proof of work in a worker thread, POST /v1/instances, keep the credential (hrk_…)
//   sealed in the settings, together with the relay it was issued by. A credential is only ever
//   sent to that relay. A relay that no longer knows it (401 unknown_instance, for example after
//   losing its database) gets one new registration. After a failed registration the next attempt
//   waits a minute; a proof of work is given up after 4 minutes (a challenge lives 5).
// - 403 suspended: the relay refuses this server. Nothing is sent for an hour.
// - send() never throws. It says what Pigeon said about the one handle: accepted, duplicate,
//   gone (the handle is dead: forget it), limited, unsupported_kind, or unavailable (anything
//   else: a timeout, a 5xx, a refusal, a registration that did not work).
//
// A handle and the credential are secrets: neither is logged or put in an error message.
//
// Logging: while sending, everything is logged at debug level only. A send also happens for the
// dev-log notifications (src/lib/push.js notifyDevLogEvent), which are a dev-log sink, and a
// warning or error from there would become a new dev-log entry and so another notification.
// Only ensureRegistered(), which runs at start-up outside the sink, logs warnings and errors.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { log } from './log.js';
import { solvePowInWorker } from './pigeonPow.js';

export const PIGEON_PRODUCT = 'sylo';
/** How long Apple keeps trying to deliver a notification, in seconds. */
export const PUSH_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 10_000;
const REPLY_CAP = 64 * 1024;
const SOLVE_LIMIT_MS = 4 * 60_000;
const REGISTER_BACKOFF_MS = 60_000;
const REJECTED_BACKOFF_MS = 10 * 60_000;
const SUSPENDED_FOR_MS = 60 * 60_000;
// Pigeon asks for 20 to 32 bits; anything harder is not an honest request.
const MAX_DIFFICULTY = 32;
const SETTING_CREDENTIAL = 'pigeon_credential';
const SETTING_URL = 'pigeon_url';
const STATUSES = new Set(['accepted', 'duplicate', 'gone', 'limited', 'unsupported_kind']);

/** Why a request to Pigeon did not work. `kind` decides what happens next. */
class PigeonFailure extends Error {
  /** @param {'suspended' | 'unknown_instance' | 'transient' | 'rejected'} kind */
  constructor(kind, code, retryAfter = null) {
    super(code);
    this.kind = kind;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// A code from Pigeon as it may reach a log: a short snake_case word, nothing else.
const cleanCode = (code) => (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null);

function failureOf(status, body, retryAfter = null) {
  const code = cleanCode(body?.error);
  if (status === 401 && code === 'unknown_instance') return new PigeonFailure('unknown_instance', code);
  if (status === 403 && code === 'suspended') return new PigeonFailure('suspended', code);
  if (status === 429 || status >= 500) {
    return new PigeonFailure('transient', code ?? `http_${status}`, retryAfter);
  }
  return new PigeonFailure('rejected', code ?? `http_${status}`);
}

/** The reply's body as JSON (null when it is not), read up to `cap` bytes. */
async function readJson(res, cap) {
  const chunks = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        throw new PigeonFailure('transient', 'reply_too_large');
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

// --- sealing the credential ----------------------------------------------------------------

const sealKey = (secret) => Buffer.from(hkdfSync('sha256', String(secret), 'sylo', 'pigeon-credential', 32));

function seal(secret, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

/** The text a sealed value holds, or null when it cannot be opened (another secret, damage). */
function open(secret, sealed) {
  try {
    const [version, iv, tag, data] = String(sealed).split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
}

// --- the client ------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {() => string | null} options.url  Pigeon's address now (null = off)
 * @param {{ get: (key: string) => Promise<string | null>, set: (key: string, value: string) => Promise<void> }} options.store
 *   where the credential is kept (the app settings)
 * @param {string} options.secret  seals the credential (the session secret)
 * @param {string} [options.version]  this Sylo's version, for the relay's operator
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(challenge: string, difficulty: number, limitMs: number) => Promise<string>} [options.solve]
 */
export function createPigeonClient({
  url,
  store,
  secret,
  version,
  fetchImpl,
  now = Date.now,
  solve = solvePowInWorker,
}) {
  const doFetch = (...args) => (fetchImpl ?? fetch)(...args);
  let backoffUntil = 0;
  let suspendedUntil = 0;
  let registering = null;

  async function call(method, base, path, { bearer, body } = {}) {
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new PigeonFailure('transient', timedOut ? 'timeout' : 'network_error');
    }
    const json = await readJson(res, REPLY_CAP);
    const retryAfter = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10);
    return { status: res.status, json, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null };
  }

  /** Log at `level` when `loud` (start-up), otherwise at debug. */
  const report = (loud, level, message) => (loud ? log[level] : log.debug)('pigeon', message);

  function suspend(loud) {
    if (now() >= suspendedUntil) {
      report(loud, 'error', 'Postal Pigeon has suspended this server; no push notifications for an hour.');
    }
    suspendedUntil = now() + SUSPENDED_FOR_MS;
  }

  async function storedCredential(base, loud) {
    try {
      const [sealed, forUrl] = await Promise.all([store.get(SETTING_CREDENTIAL), store.get(SETTING_URL)]);
      if (!sealed || forUrl !== base) return null;
      const credential = open(secret, sealed);
      if (!credential)
        report(loud, 'warn', 'The stored Pigeon credential cannot be opened; registering again.');
      return credential;
    } catch {
      return null;
    }
  }

  async function register(base) {
    const challenge = await call('GET', base, '/v1/challenge');
    if (challenge.status !== 200) throw failureOf(challenge.status, challenge.json, challenge.retryAfter);
    const { challenge: text, difficulty } = challenge.json ?? {};
    if (
      typeof text !== 'string' ||
      !text ||
      text.length > 256 ||
      !Number.isInteger(difficulty) ||
      difficulty < 0 ||
      difficulty > MAX_DIFFICULTY
    ) {
      throw new PigeonFailure('rejected', 'challenge_out_of_range');
    }
    let nonce;
    try {
      nonce = await solve(text, difficulty, SOLVE_LIMIT_MS);
    } catch (err) {
      throw new PigeonFailure('transient', err?.message === 'pow_timeout' ? 'pow_timeout' : 'pow_failed');
    }
    const registered = await call('POST', base, '/v1/instances', {
      body: {
        challenge: text,
        nonce,
        product: PIGEON_PRODUCT,
        ...(/^[A-Za-z0-9._+-]{1,32}$/.test(version ?? '') ? { version } : {}),
      },
    });
    if (registered.status !== 201) throw failureOf(registered.status, registered.json, registered.retryAfter);
    const credential = registered.json?.instance_credential;
    if (typeof credential !== 'string' || !credential.startsWith('hrk_') || credential.length > 256) {
      throw new PigeonFailure('rejected', 'malformed_credential');
    }
    try {
      await store.set(SETTING_CREDENTIAL, seal(secret, credential));
      await store.set(SETTING_URL, base);
    } catch {
      throw new PigeonFailure('rejected', 'storage_error');
    }
    log.info('pigeon', 'Registered with Postal Pigeon.');
    return credential;
  }

  /** The credential for `base`: the stored one (unless it is `stale`), else a new registration. */
  async function credential(base, stale = null, loud = false) {
    const stored = await storedCredential(base, loud);
    if (stored && stored !== stale) return stored;
    if (now() < backoffUntil) throw new PigeonFailure('transient', 'registration_backoff');
    // One registration at a time; whoever arrives meanwhile waits for it and uses its result.
    registering ??= register(base)
      .then(
        (value) => {
          backoffUntil = 0;
          return value;
        },
        (err) => {
          if (err.kind === 'suspended') suspend(loud);
          else {
            // A refusal (rather than trouble that may pass) is not worth solving a new proof of
            // work for every minute.
            backoffUntil = now() + (err.kind === 'rejected' ? REJECTED_BACKOFF_MS : REGISTER_BACKOFF_MS);
            report(loud, 'warn', `Registering with Postal Pigeon failed (${err.code ?? 'error'}).`);
          }
          throw err;
        }
      )
      .finally(() => {
        registering = null;
      });
    return registering;
  }

  function push(base, bearer, handle, ref, collapse) {
    const body = {
      event_id: randomUUID(),
      handles: [handle],
      kind: 'alert',
      ...(ref ? { ref } : {}),
      ...(collapse ? { collapse } : {}),
      ttl: PUSH_TTL_SECONDS,
    };
    return call('POST', base, '/v1/push', { bearer, body });
  }

  return {
    /** Is the relay refusing this server right now? */
    suspended: () => now() < suspendedUntil,

    /**
     * Register now if this server has no credential yet (what the first send would do), so the
     * start-up log shows whether Pigeon works. Never throws.
     * @returns {Promise<boolean>} whether there is a credential afterwards
     */
    async ensureRegistered() {
      const base = url();
      if (!base || now() < suspendedUntil) return false;
      try {
        await credential(base, null, true);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Ask Pigeon to push one alert to one handle. The text is not in it: `ref` is what the app
     * asks this server for.
     * @param {string} handle  hrh_…
     * @param {{ ref: string, collapse?: string }} message  collapse: at most 32 of A-Za-z0-9_-
     * @returns {Promise<{ status: 'accepted' | 'duplicate' | 'gone' | 'limited' | 'unsupported_kind' | 'unavailable', retryAfter?: number, reason?: string }>}
     */
    async send(handle, { ref, collapse }) {
      const base = url();
      if (!base) return { status: 'unavailable', reason: 'not_configured' };
      if (now() < suspendedUntil) return { status: 'unavailable', reason: 'suspended' };
      try {
        let bearer = await credential(base);
        let reply = await push(base, bearer, handle, ref, collapse);
        if (reply.status === 401 && failureOf(401, reply.json).kind === 'unknown_instance') {
          bearer = await credential(base, bearer);
          reply = await push(base, bearer, handle, ref, collapse);
        }
        if (reply.status !== 200) throw failureOf(reply.status, reply.json, reply.retryAfter);
        const result = Array.isArray(reply.json?.results) ? reply.json.results[0] : null;
        const status = STATUSES.has(result?.status) ? result.status : 'unavailable';
        const retryAfter = Number.isInteger(result?.retry_after) ? result.retry_after : undefined;
        return { status, ...(retryAfter !== undefined ? { retryAfter } : {}) };
      } catch (err) {
        if (!(err instanceof PigeonFailure)) return { status: 'unavailable', reason: 'error' };
        if (err.kind === 'suspended') suspend(false);
        return {
          status: 'unavailable',
          reason: err.code,
          ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
        };
      }
    },
  };
}
