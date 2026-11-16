// Wise Wren (https://github.com/Ferdinand99/Wise-Wren) as Sylo's optional updater. Sylo never gets
// access to the Docker socket: an operator who runs Wise Wren can let the dashboard ask it to update
// Sylo's own target. This file is the whole client: what Wise Wren knows about the target, "approve
// the update" and the progress of the run. It only ever calls three Wise Wren routes, all on the one
// target id that WISE_WREN_TARGET_ID names:
//
//   GET  /api/v1/targets/{id}        what Wren sees (an update, the version key, why it would refuse)
//   POST /api/v1/targets/{id}/approve  approve exactly that version
//   GET  /api/v1/runs/{id}           the run's steps (and GET /api/v1/runs?target_id={id}&limit=1)
//
// The token (WISE_WREN_TOKEN) is a secret: it is only ever put in the Authorization header of these
// requests. It is not in any error, log line or answer this file produces, and nothing here follows
// a redirect (a redirect to another host must not receive it).
import { BlockList, isIP } from 'node:net';

// Addresses an `http://` Wise Wren may live on: this machine and the local network (as the Wren agent's
// own rule for its server address).
const lan = new BlockList();
for (const [net, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
]) {
  lan.addSubnet(net, prefix, 'ipv4');
}
lan.addAddress('::1', 'ipv6');
lan.addSubnet('fc00::', 7, 'ipv6');
lan.addSubnet('fe80::', 10, 'ipv6');

const LOCAL_NAME = /\.(local|lan|home|home\.arpa|internal|ts\.net)$/i;

function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) return lan.check(host, 'ipv4');
  if (family === 6) return lan.check(host, 'ipv6');
  // A single-label name (a Compose service such as "wise-wren") never leaves the host's network.
  return host === 'localhost' || !host.includes('.') || LOCAL_NAME.test(host);
}

/**
 * Wise Wren's address in its canonical form, without a trailing slash: `https`, or `http` for this
 * machine and the local network. No credentials, query or fragment.
 * @param {unknown} raw
 * @returns {string}
 * @throws {Error} with a reason when it is not usable
 */
export function checkWrenUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('not a URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('it must not contain credentials, a query or a fragment');
  }
  if (!url.hostname) throw new Error('it has no host');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('it must be https (http is only for the local network)');
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('it must be https (http is only for the local network)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The Wise Wren settings from the environment, or null when the integration is off. A partial or
 * unusable setting turns it off too, with a reason for the log (never the token).
 * @param {Record<string, string | undefined>} env
 * @returns {{ settings: { url: string, token: string, targetId: number } | null, problem: string | null }}
 */
export function readWrenSettings(env) {
  const get = (name) => (env[name] ?? '').trim();
  const url = get('WISE_WREN_URL');
  const token = get('WISE_WREN_TOKEN');
  const id = get('WISE_WREN_TARGET_ID');
  if (!url && !token && !id) return { settings: null, problem: null };
  if (!url || !token || !id) {
    return {
      settings: null,
      problem: 'WISE_WREN_URL, WISE_WREN_TOKEN and WISE_WREN_TARGET_ID must all be set; Wise Wren is off.',
    };
  }
  const targetId = Number(id);
  if (!/^\d{1,9}$/.test(id) || !Number.isSafeInteger(targetId) || targetId < 1) {
    return { settings: null, problem: 'WISE_WREN_TARGET_ID must be a whole number; Wise Wren is off.' };
  }
  if (/[\s\r\n]/.test(token) || token.length > 512) {
    return { settings: null, problem: 'WISE_WREN_TOKEN is not usable; Wise Wren is off.' };
  }
  try {
    return { settings: { url: checkWrenUrl(url), token, targetId }, problem: null };
  } catch (err) {
    return { settings: null, problem: `WISE_WREN_URL is not usable (${err.message}); Wise Wren is off.` };
  }
}

/**
 * What went wrong, in a form the routes map to an answer. `message` is safe to show an operator: it
 * is written here or is Wren's own short error text, and holds no token.
 */
export class WrenError extends Error {
  /** @param {'unreachable'|'unauthorized'|'forbidden'|'not_found'|'conflict'|'rate_limited'|'bad_request'|'server'|'invalid'} kind */
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'WrenError';
    this.kind = kind;
    this.status = status;
  }
}

const KIND_BY_STATUS = new Map([
  [400, 'bad_request'],
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [422, 'bad_request'],
  [429, 'rate_limited'],
]);

const FALLBACK_TEXT = {
  unauthorized: "Wise Wren did not accept Sylo's token.",
  forbidden: 'Wise Wren does not allow this token to do that.',
  not_found: 'Wise Wren does not know this target.',
  conflict: 'Wise Wren refused this update.',
  rate_limited: 'Wise Wren says to slow down; try again in a moment.',
  bad_request: 'Wise Wren did not accept the request.',
  server: 'Wise Wren had an error.',
};

/** Wren's own error text when it sent a short one, never anything that could be markup or a secret. */
function errorText(body) {
  const raw =
    typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300) return '';
  return text;
}

// Run states in which Wren is done with the run.
export const TERMINAL_RUN = new Set([
  'succeeded',
  'rolled_back',
  'failed',
  'rollback_failed',
  'refused',
  'cancelled',
  'lapsed',
]);

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(v) ? v : null);

/** A Wise Wren run as the dashboard needs it: no step logs (they can hold paths and image names). */
export function shapeRun(run) {
  if (!run || typeof run !== 'object' || !Number.isSafeInteger(run.id)) return null;
  const status = str(run.status, 40) ?? 'unknown';
  return {
    id: run.id,
    targetId: Number.isSafeInteger(run.target?.id) ? run.target.id : null,
    status,
    finished: TERMINAL_RUN.has(status),
    ok: status === 'succeeded',
    detail: str(run.detail, 300),
    version: str(run.version, 80),
    createdAt: str(run.created_at, 40),
    startedAt: str(run.started_at, 40),
    finishedAt: str(run.finished_at, 40),
    steps: Array.isArray(run.steps)
      ? run.steps.slice(0, 20).map((s) => ({
          step: str(s?.step, 40),
          status: str(s?.status, 40),
          durationMs: num(s?.duration_ms),
        }))
      : [],
  };
}

/** The target as the dashboard needs it. */
export function shapeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const blocked =
    typeof t.blocked_reason === 'string' && t.blocked_reason ? t.blocked_reason.slice(0, 300) : null;
  return {
    name: str(t.name, 120),
    server: str(t.server?.name, 120),
    status: ['update', 'current', 'unknown'].includes(t.status) ? t.status : 'unknown',
    versionKey: typeof t.version_key === 'string' && t.version_key.length <= 2000 ? t.version_key : null,
    installedVersion: str(t.installed_version, 80) || null,
    latestVersion: str(t.latest_version, 80) || null,
    mode: str(t.effective_mode, 20),
    blockedReason: blocked,
    skipped: Boolean(t.skipped),
    snoozed: Boolean(t.snoozed_until),
    lastCheckedAt: str(t.last_checked_at, 40),
  };
}

/**
 * @param {{ url: string, token: string, targetId: number }} settings
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export function createWrenClient(settings, { fetchImpl, timeoutMs = 10_000 } = {}) {
  const { url, token, targetId } = settings;

  async function call(method, path, body) {
    let res;
    try {
      res = await (fetchImpl ?? globalThis.fetch)(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': 'Sylo (update via Wise Wren)',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry the request (and its token) to wherever it points.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The error of a failed request can hold the address; the reason alone is enough.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new WrenError(
        'unreachable',
        timedOut ? 'Wise Wren did not answer in time.' : 'Wise Wren is not reachable.'
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new WrenError('server', 'Wise Wren answered with a redirect; use its final address.', res.status);
    }
    let data;
    try {
      const text = await res.text();
      data = text.length <= 1_000_000 && text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const kind = KIND_BY_STATUS.get(res.status) ?? 'server';
      throw new WrenError(kind, errorText(data) || FALLBACK_TEXT[kind], res.status);
    }
    if (data === null || typeof data !== 'object') {
      throw new WrenError('invalid', 'Wise Wren sent an answer Sylo does not understand.', res.status);
    }
    return data;
  }

  return {
    targetId,
    async target() {
      return shapeTarget(await call('GET', `/api/v1/targets/${targetId}`));
    },
    /**
     * Approve the update now. With a `versionKey` the approval is for exactly that version (Wren
     * refuses it when a newer one has appeared); without one Wren approves whatever it sees.
     * @returns {Promise<{ runId: number, status: string }>}
     */
    async approve(versionKey) {
      const data = await call(
        'POST',
        `/api/v1/targets/${targetId}/approve`,
        versionKey ? { version_key: versionKey } : {}
      );
      if (!Number.isSafeInteger(data.run_id)) {
        throw new WrenError('invalid', 'Wise Wren did not say which run it started.');
      }
      return { runId: data.run_id, status: str(data.status, 40) ?? 'queued' };
    },
    /** One run with its steps, or a WrenError (also `not_found` for a run of another target). */
    async run(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new WrenError('not_found', 'No such run.');
      const run = shapeRun(await call('GET', `/api/v1/runs/${id}`));
      if (!run || run.targetId !== targetId) throw new WrenError('not_found', 'No such run.');
      return run;
    },
    /** The newest run of the target (without steps), or null when it has none. */
    async latestRun() {
      const data = await call('GET', `/api/v1/runs?target_id=${targetId}&limit=1`);
      const [first] = Array.isArray(data.runs) ? data.runs : [];
      const run = shapeRun(first);
      return run && run.targetId === targetId ? run : null;
    },
  };
}
