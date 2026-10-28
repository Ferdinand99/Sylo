// "Back to classic dashboard" (/?classic=1): the one way to stay on the classic dashboard for this
// release. The choice is `session.preferClassic`; open mode has no session, so the same choice is
// kept in a plain session cookie there. Opening the new dashboard again ends it. The stored
// `dashboard_version` preference (src/db/userPrefs.js) no longer opts anyone out.
import { config } from '../../config.js';

const CLASSIC_COOKIE = 'sylo.classic';
const cookieSet = (req) => /(?:^|;\s*)sylo\.classic=1(?:;|$)/.test(req.headers.cookie ?? '');

/** Did this browser choose the classic dashboard? */
export function prefersClassic(req) {
  return Boolean(req.session?.preferClassic) || (!config.authEnabled && cookieSet(req));
}

/** Remember the choice for this browser session. */
export function chooseClassic(req, res) {
  if (req.session) req.session.preferClassic = true;
  else if (!config.authEnabled) {
    res.cookie(CLASSIC_COOKIE, '1', { httpOnly: true, sameSite: 'lax', path: '/' });
  }
}

/** Forget the choice (the new dashboard was opened). */
export function endClassicChoice(req, res) {
  if (req.session?.preferClassic) delete req.session.preferClassic;
  if (!config.authEnabled && cookieSet(req)) res.clearCookie(CLASSIC_COOKIE, { path: '/' });
}

/**
 * A person opening a page in their browser, as opposed to a script, a monitor, an htmx swap or an
 * image tag: a GET that asks for `text/html` by name (curl's or a Docker healthcheck's catch-all
 * Accept is not a page visit) and prefers it to JSON.
 */
export function isBrowserPageVisit(req) {
  if (req.method !== 'GET') return false;
  if (req.get('HX-Request')) return false;
  // An app or script sends a bearer token; a browser behind HTTP basic auth (a proxy's
  // auth_basic) sends `Authorization: Basic` on every page visit and is still a person.
  if (/^bearer\b/i.test(req.get('Authorization') ?? '')) return false;
  if (!/text\/html/i.test(req.get('Accept') ?? '')) return false;
  return req.accepts(['html', 'json']) === 'html';
}
