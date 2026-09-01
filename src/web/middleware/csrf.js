// CSRF protection for the dashboard.
//
// Only active when auth is enabled (that is the only time a session cookie
// exists). Each session gets a random token; it is exposed to templates as
// `res.locals.csrfToken` (rendered into a <meta> tag by the header partial and
// echoed back by public/app.js on every form submit and JSON action). Requests
// that change state must present it in the `x-csrf-token` header or a `_csrf`
// body field.
//
// Exempt: safe methods, and the /auth, /verify and /appeal flows, which are
// unauthenticated and already gated by their own signed tokens.
import { randomBytes } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = [/^\/auth(\/|$)/, /^\/verify(\/|$)/, /^\/appeal(\/|$)/];

export function csrf(req, res, next) {
  // Open mode: no session to bind a token to, and the dashboard is already
  // "trusted LAN only". Nothing to do.
  if (!req.session) return next();

  if (!req.session.csrf) req.session.csrf = randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;

  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT.some((re) => re.test(req.path))) return next();

  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (sent && sent === req.session.csrf) return next();

  res
    .status(403)
    .type('text/plain')
    .send('CSRF check failed — reload the page and try again.');
}
