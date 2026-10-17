// A small client for Apple's App Store Connect API (https://api.appstoreconnect.apple.com).
//
// Auth is a JWT signed with an API key's private key (.p8, ES256): header { alg, kid, typ },
// claims { iss (team keys), iat, exp, aud: 'appstoreconnect-v1' } or { sub: 'user' } for an
// individual key. Apple rejects a lifetime over 20 minutes; one token is reused for 15.
// No dependency: node:crypto signs, fetch calls. fetch and sleep are injectable for tests.
import { createPrivateKey, createSign } from 'node:crypto';

const BASE_URL = 'https://api.appstoreconnect.apple.com';
const TOKEN_LIFETIME_S = 20 * 60;
const TOKEN_REUSE_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const NETWORK_RETRY_MS = 2_000;

export class AppStoreConnectError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = 'AppStoreConnectError';
    this.status = status;
  }
}

/**
 * The .p8 key as a PEM string. Accepts the PEM itself, a single-line PEM with literal "\n"
 * (how it survives an environment variable), or base64 of the PEM. Null when it is not a key.
 * @param {string | null | undefined} raw
 */
export function normalisePrivateKey(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (!text.includes('-----BEGIN')) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8').trim();
    } catch {
      return null;
    }
  }
  text = text.replaceAll('\\n', '\n');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(text)) return null;
  try {
    createPrivateKey(text);
  } catch {
    return null;
  }
  return `${text}\n`;
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * An ES256 JWT with exactly this header and these claims (also the APNs provider token, see
 * src/lib/apns.js). The signature is raw r||s (IEEE P1363), as JWS requires, not DER.
 */
export function signEs256Jwt(header, claims, privateKey) {
  const input = `${b64url(header)}.${b64url(claims)}`;
  const signature = createSign('SHA256').update(input).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/**
 * @param {{ keyId: string, issuerId?: string | null, privateKey: string, iat?: number, lifetime?: number }} opts
 *   `issuerId` null/empty means an individual key (sub "user", no iss).
 */
export function signJwt({
  keyId,
  issuerId,
  privateKey,
  iat = Math.floor(Date.now() / 1000),
  lifetime = TOKEN_LIFETIME_S,
}) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = {
    ...(issuerId ? { iss: issuerId } : { sub: 'user' }),
    iat,
    exp: iat + Math.min(lifetime, TOKEN_LIFETIME_S),
    aud: 'appstoreconnect-v1',
  };
  return signEs256Jwt(header, claims, privateKey);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   keyId: string, issuerId?: string | null, privateKey: string,
 *   fetchImpl?: typeof fetch, now?: () => number, sleep?: (ms: number) => Promise<void>, baseUrl?: string
 * }} opts
 */
export function createAppStoreConnect({
  keyId,
  issuerId = null,
  privateKey,
  fetchImpl = fetch,
  now = Date.now,
  sleep = defaultSleep,
  baseUrl = BASE_URL,
}) {
  let cached = { token: null, at: 0 };
  const apiOrigin = new URL(baseUrl).origin;

  function token() {
    if (!cached.token || now() - cached.at > TOKEN_REUSE_MS) {
      cached = { token: signJwt({ keyId, issuerId, privateKey, iat: Math.floor(now() / 1000) }), at: now() };
    }
    return cached.token;
  }

  const urlFor = (path, query) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v != null && v !== '') qs.set(k, String(v));
    const suffix = qs.size ? `?${qs}` : '';
    return path.startsWith('http') ? path : `${baseUrl}${path}${suffix}`;
  };

  async function request(url, { retry = true, accept = 'application/json' } = {}) {
    // The bearer token only ever goes to Apple: a pagination link (or a path) that points
    // anywhere else is refused before anything is sent.
    if (new URL(url).origin !== apiOrigin) {
      throw new AppStoreConnectError(`Refusing to send the API token to ${new URL(url).origin}`);
    }
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token()}`, Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout or a dropped connection: one more try, then let the caller see the error.
      if (!retry) throw err;
      await sleep(NETWORK_RETRY_MS);
      return request(url, { retry: false, accept });
    }
    if (res.status === 429 && retry) {
      const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 5, 1), 60);
      await sleep(wait * 1000);
      return request(url, { retry: false, accept });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || '';
      } catch {
        /* not JSON */
      }
      throw new AppStoreConnectError(
        `App Store Connect ${res.status}${detail ? `: ${detail}` : ''} (${new URL(url).pathname})`,
        res.status
      );
    }
    return res;
  }

  return {
    token,
    /** One JSON request. @returns {Promise<any>} */
    async get(path, query) {
      return (await request(urlFor(path, query))).json();
    },
    /** A request whose body is not JSON (a gzipped sales report). @returns {Promise<Buffer>} */
    async getBuffer(path, query) {
      const res = await request(urlFor(path, query), { accept: 'application/a-gzip, application/json' });
      return Buffer.from(await res.arrayBuffer());
    },
    /**
     * Follow `links.next` and concatenate `data` (and `included`).
     * @returns {Promise<{ data: any[], included: any[] }>}
     */
    async getAll(path, query, { maxPages = 10 } = {}) {
      const out = { data: [], included: [] };
      let url = urlFor(path, query);
      for (let page = 0; page < maxPages && url; page += 1) {
        const body = await (await request(url)).json();
        out.data.push(...(body.data ?? []));
        out.included.push(...(body.included ?? []));
        url = body.links?.next ?? null;
      }
      return out;
    },
  };
}
