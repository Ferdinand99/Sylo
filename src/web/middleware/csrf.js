// CSRF protection for the dashboard.
//
// Two layers:
//  1. A same-origin check (Origin / Referer host must match Host) on every
//     state-changing request. This runs even in open mode, where there is no
//     session — a malicious page in a LAN browser can POST but cannot forge a
//     same-site Origin. Requests with neither header (curl, scripts) are allowed;
//     they are not a cross-site browser vector.
//  2. When auth is enabled, a per-session random token that must come back in the
//     `x-csrf-token` header or a `_csrf` body field. It is exposed to templates
//     as `res.locals.csrfToken` (a <meta> tag, echoed by htmx-setup.js / app.js).
//
// Exempt: safe methods, and the /auth, /verify and /appeal flows, which are
// unauthenticated and already gated by their own signed tokens.
import { randomBytes } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = [/^\/auth(\/|$)/, /^\/verify(\/|$)/, /^\/appeal(\/|$)/];

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

export function csrf(req, res, next) {
  const stateChanging = !SAFE_METHODS.has(req.method) && !EXEMPT.some((re) => re.test(req.path));

  if (stateChanging && !sameOrigin(req)) {
    return res.status(403).type('text/plain').send('Cross-origin request blocked.');
  }

  // Open mode: no session to bind a token to — the same-origin check above is the
  // whole defence.
  if (!req.session) return next();

  if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;

  if (!stateChanging) return next();

  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (sent && sent === req.session.csrf) return next();

  res.status(403).type('text/plain').send('CSRF check failed — reload the page and try again.');
}
