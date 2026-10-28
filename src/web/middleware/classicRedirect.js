// Old dashboard addresses open the matching page in the dashboard (/v2), permanently.
//
// The classic dashboard is gone (Sylo 5.0), but links in Discord messages, bookmarks and docs still
// point at its addresses (/guilds/<key>/tickets/5, /account, /health ...), so a browser visit to one
// of them is sent to the same page under /v2 with a 301. Only plain browser page visits are
// redirected: never a POST, a JSON/API caller, a monitor reading /health, or a download. Those get
// the 404 an unknown address gets.

// A server's key in a URL: a Discord id, or `fluxer:<id>` (the colon may arrive as %3A).
const KEY = '((?:fluxer:)?\\d{17,20})';
const MODULE = '([a-z0-9][a-z0-9_-]{0,63})';
// A backup file's name, as the Health page lists it.
const BACKUP = '([A-Za-z0-9][A-Za-z0-9._-]{0,199})';
// The editors inside a module's old page (an item of a list: /m/reminders/r/3, /m/roles/rr/new ...).
// The dashboard edits those inside the module's own page.
const MODULE_ITEM = '(?:r|s|w|hub|rr|sb|cmd)';

/**
 * The mapping table: old path -> path in the dashboard (under /v2).
 * Each entry matches a whole path, case-insensitively, with or without a trailing slash.
 * `to` receives the regex match (key = match[1] for server pages) and returns the new path.
 * @type {Array<{ from: string, pattern: RegExp, to: (m: RegExpExecArray) => string, query?: string[] }>}
 */
export const CLASSIC_REDIRECTS = [
  // Pages that are not tied to a server.
  { from: '/account', to: () => '/account' },
  { from: '/settings', to: () => '/settings' },
  { from: '/health', to: () => '/health' },
  { from: '/stats', to: () => '/stats' },
  { from: '/commands', to: () => '/commands' },
  { from: '/roadmap', to: () => '/roadmap' },
  { from: '/roadmap/admin', to: () => '/roadmap/admin' },
  // A backup download is a link on the Health page.
  { from: '/health/backups/:backup', to: () => '/health' },
  // A server's pages.
  { from: '/guilds/:key', to: (m) => `/guilds/${m[1]}` },
  { from: '/guilds/:key/overview', to: (m) => `/guilds/${m[1]}` },
  { from: '/guilds/:key/settings', to: (m) => `/guilds/${m[1]}/settings` },
  { from: '/guilds/:key/general', to: (m) => `/guilds/${m[1]}/settings` },
  // The configuration export is a button on the server's settings page.
  { from: '/guilds/:key/export', to: (m) => `/guilds/${m[1]}/settings` },
  // ?user= is the member a lookup was for.
  { from: '/guilds/:key/member-data', to: (m) => `/guilds/${m[1]}/member-data`, query: ['user'] },
  // Per-server command settings are a tab on the Moderation page.
  { from: '/guilds/:key/commands', to: (m) => `/guilds/${m[1]}/moderation/commands` },
  { from: '/guilds/:key/moderation', to: (m) => `/guilds/${m[1]}/moderation` },
  // Unbanning is on the Infractions tab of the Moderation page.
  { from: '/guilds/:key/unban', to: (m) => `/guilds/${m[1]}/moderation/infractions` },
  { from: '/guilds/:key/appeals', to: (m) => `/guilds/${m[1]}/appeals` },
  { from: '/guilds/:key/leaderboard', to: (m) => `/guilds/${m[1]}/leaderboard` },
  { from: '/guilds/:key/insights', to: (m) => `/guilds/${m[1]}/insights` },
  { from: '/guilds/:key/audit', to: (m) => `/guilds/${m[1]}/audit` },
  { from: '/guilds/:key/tickets', to: (m) => `/guilds/${m[1]}/tickets` },
  { from: '/guilds/:key/tickets/:ticketId', to: (m) => `/guilds/${m[1]}/tickets/${m[2]}` },
  // The transcript download is a button on the ticket's own page.
  { from: '/guilds/:key/tickets/:ticketId/transcript', to: (m) => `/guilds/${m[1]}/tickets/${m[2]}` },
  { from: '/guilds/:key/messages', to: (m) => `/guilds/${m[1]}/messages` },
  { from: '/guilds/:key/messages/:id', to: (m) => `/guilds/${m[1]}/messages/${m[2]}` },
  { from: '/guilds/:key/m/:moduleId', to: (m) => `/guilds/${m[1]}/m/${m[2]}` },
  { from: '/guilds/:key/m/:moduleId/<item>/...', to: (m) => `/guilds/${m[1]}/m/${m[2]}` },
].map((entry) => ({ ...entry, pattern: patternFor(entry.from) }));

function patternFor(from) {
  const source = from
    .replace(':key', KEY)
    .replace(':ticketId', '(\\d{1,12})')
    .replace(':backup', BACKUP)
    .replace(':moduleId', MODULE)
    .replace(':id', '(\\d{1,12}|new)')
    .replace('<item>/...', `${MODULE_ITEM}(?:/[A-Za-z0-9_-]{1,64})*`);
  return new RegExp(`^${source}/?$`, 'i');
}

/**
 * The dashboard address for an old page address, or null when the page has no counterpart (a
 * form post target, an unknown address).
 * @param {string} rawPath the request path as received (may carry %3A for the colon of a Fluxer key)
 * @param {Record<string, unknown>} [query]
 */
export function v2PathFor(rawPath, query = {}) {
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  for (const { pattern, to, query: keep = [] } of CLASSIC_REDIRECTS) {
    const m = pattern.exec(path);
    if (!m) continue;
    // Keys and module ids are canonical in lower case; the dashboard's routes are case-sensitive.
    const target = `/v2${to(m.map((part) => part.toLowerCase()))}`;
    const params = new URLSearchParams();
    for (const name of keep) {
      if (typeof query[name] === 'string' && query[name]) params.set(name, query[name]);
    }
    const qs = params.toString();
    return qs ? `${target}?${qs}` : target;
  }
  return null;
}

/**
 * A person opening a page in their browser, as opposed to a script, a monitor or an image tag: a GET
 * that asks for `text/html` by name (curl's or a Docker healthcheck's catch-all Accept is not a page
 * visit) and prefers it to JSON.
 * @param {import('express').Request} req
 */
export function isBrowserPageVisit(req) {
  if (req.method !== 'GET') return false;
  // An app or script sends a bearer token; a browser behind HTTP basic auth (a proxy's
  // auth_basic) sends `Authorization: Basic` on every page visit and is still a person.
  if (/^bearer\b/i.test(req.get('Authorization') ?? '')) return false;
  if (!/text\/html/i.test(req.get('Accept') ?? '')) return false;
  return req.accepts(['html', 'json']) === 'html';
}

/** @type {import('express').RequestHandler} */
export function classicRedirect(req, res, next) {
  if (!isBrowserPageVisit(req)) return next();
  const target = v2PathFor(req.path, req.query);
  if (!target) return next();
  return res.redirect(301, target);
}
