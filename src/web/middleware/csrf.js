// CSRF protection for the dashboard.
//
// Two layers:
//  1. A same-origin check (Origin / Referer host must match Host) on every
//     state-changing request. This runs even in open mode, where there is no
//     session — a malicious page in a LAN browser can POST but cannot forge a
//     same-site Origin. Requests with neither header (curl, scripts) are allowed;
//     they are not a cross-site browser vector.
//  2. When auth is enabled, a per-session random token that must come back in the
//     `x-csrf-token` header. The dashboard reads it from GET /api/v2/csrf.
//
// Exempt: safe methods, and the /auth, /verify and /appeal flows, which are
// unauthenticated and already gated by their own signed tokens. Also exempt: an
// /api/ request that carries an app token (Authorization: Bearer). A browser
// cannot attach that header to a cross-site request without a CORS preflight,
// and Sylo answers no preflight, so such a request cannot be forged. It is
// judged by its token alone (see attachAccount), never by a cookie.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isTokenRequest } from '../lib/bearer.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// /api/mobile/token: the Sylo app's code-for-token exchange (no cookie involved; the one-time
// code and its PKCE verifier are the proof). /api/mobile/push: refuses every cookie request
// itself, with a JSON answer the app can read. /api/push-relay: instance-to-relay calls, no
// account or cookie at all; a relay token is the proof (src/web/routes/pushRelay.js).
const EXEMPT = [
  // /auth/logout checks the token itself (auth.js): the /auth router runs before this one.
  /^\/auth(\/|$)/,
  /^\/verify(\/|$)/,
  /^\/appeal(\/|$)/,
  /^\/api\/mobile\/token$/,
  /^\/api\/mobile\/push(\/|$)/,
  /^\/api\/push-relay\//,
];

/** True when the request's Origin/Referer host matches the Host it was sent to. */
function sameOrigin(req) {
  const source = req.get('origin') || req.get('referer');
  if (!source) return true; // non-browser client; not a CSRF vector
  try {
    return new URL(source).host === req.get('host');
  } catch {
    return false;
  }
}

/** The new dashboard (and the app) read JSON errors; pages get plain text. */
function refuse(req, res, message) {
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: message });
  return res.status(403).type('text/plain').send(message);
}

function sameToken(sent, expected) {
  const a = Buffer.from(String(sent));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Does the request carry this session's CSRF token? For routes mounted before the csrf
 * middleware runs (the /auth router, for logout).
 */
export function hasValidCsrfToken(req) {
  const sent = req.get('x-csrf-token');
  return Boolean(sent && req.session?.csrf && sameToken(sent, req.session.csrf) && sameOrigin(req));
}

export function csrf(req, res, next) {
  if (isTokenRequest(req)) return next();
  const stateChanging = !SAFE_METHODS.has(req.method) && !EXEMPT.some((re) => re.test(req.path));

  if (stateChanging && !sameOrigin(req)) {
    return refuse(req, res, 'Cross-origin request blocked.');
  }

  // Open mode: no session to bind a token to — the same-origin check above is the
  // whole defence.
  if (!req.session) return next();

  if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('hex');

  if (!stateChanging) return next();

  const sent = req.get('x-csrf-token');
  if (sent && sameToken(sent, req.session.csrf)) return next();

  refuse(req, res, 'CSRF check failed — reload the page and try again.');
}
