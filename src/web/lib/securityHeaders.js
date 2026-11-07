// The security headers every page carries: an enforcing Content Security Policy, HSTS over
// https, and the framing / sniffing / referrer headers.
//
// What the dashboard needs from other origins is short, so the policy can be strict:
//  - Scripts: its own files only. The Sentry browser SDK is vendored (/vendor), so the only
//    other script origin is Keen Kestrel's k.js, and only when visit counts are on
//    (lib/telemetry.js). No inline scripts anywhere (the pages load /theme.js and
//    /v2/theme.js instead).
//  - Styles: its own stylesheets only. React's style props are set through the CSSOM, which
//    `style-src` does not govern.
//  - Connections: the dashboard's own API, plus the DSN's host, where error reports go.
//  - Images: any https image (admins enter embed image URLs) and data: URIs.
//  - The verify page adds Cloudflare Turnstile for itself (see verify.js).
import { parseDsn } from './telemetry.js';

/** The Content-Security-Policy / Report-Only header names. */
export const CSP_HEADER = 'Content-Security-Policy';
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

/** Cloudflare Turnstile, which the verify page embeds. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// `sylo:` because the app sign-in form (POST /auth/mobile/confirm) answers with a redirect to
// sylo://auth, and Chromium checks form-action against a form's redirects too. The OAuth
// providers need nothing here: "Log in with ..." is a link, not a form.
const FORM_ACTION = ["'self'", 'sylo:'];

/**
 * The policy as a header value.
 * @param {{
 *   dsnOrigin?: string | null,
 *   kestrelOrigin?: string | null,
 *   extra?: Record<string, string[]>,
 * }} [opts]
 *  - `dsnOrigin`: where error reports go (connect-src only; the SDK itself is same-origin).
 *  - `kestrelOrigin`: where Keen Kestrel's k.js is loaded from and posts to (script-src and
 *    connect-src). Unset unless visit counts are on.
 *  - `extra`: further sources per directive, added to the defaults.
 * @returns {string}
 */
export function buildCsp({ dsnOrigin, kestrelOrigin, extra = {} } = {}) {
  /** @type {Record<string, string[]>} */
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...(kestrelOrigin ? [kestrelOrigin] : [])],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': ["'self'", ...new Set([dsnOrigin, kestrelOrigin].filter(Boolean))],
    'font-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': FORM_ACTION,
  };
  for (const [name, sources] of Object.entries(extra)) {
    directives[name] = [...new Set([...(directives[name] ?? ["'self'"]), ...sources])];
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** The extra sources the verify page's Turnstile widget needs. */
export const TURNSTILE_SOURCES = {
  'script-src': [TURNSTILE_ORIGIN],
  'frame-src': [TURNSTILE_ORIGIN],
  'connect-src': [TURNSTILE_ORIGIN],
};

/**
 * Express middleware: sets the headers, and `res.locals.extendCsp(extra)` for a route that needs
 * more than the default (verify.js).
 * @param {{
 *   dashboardErrorDsn?: string | null,
 *   dashboardVisitStats?: boolean,
 *   dashboardUrl?: string | null,
 *   cspReportOnly?: boolean,
 * }} config
 */
export function securityHeaders(config) {
  const parsed = parseDsn(config.dashboardErrorDsn);
  // Like telemetrySettings(): the DSN's host is both the error endpoint and, with visit counts
  // on, Keen Kestrel. With no valid DSN the telemetry script loads nothing.
  const dsnOrigin = parsed?.origin ?? null;
  const kestrelOrigin = parsed && config.dashboardVisitStats ? parsed.origin : null;
  const header = config.cspReportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
  const hsts = /^https:/i.test(config.dashboardUrl ?? '') ? 'max-age=15552000' : null;
  const base = buildCsp({ dsnOrigin, kestrelOrigin });

  return function securityHeadersMiddleware(_req, res, next) {
    res.set('X-Frame-Options', 'DENY');
    res.set(header, base);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (hsts) res.set('Strict-Transport-Security', hsts);
    res.locals.extendCsp = (extra) => res.set(header, buildCsp({ dsnOrigin, kestrelOrigin, extra }));
    next();
  };
}
