// Old dashboard addresses open the matching page in the new dashboard (/v2).
//
// The new dashboard is the default; the classic one is kept for one more release behind
// /?classic=1 and a retirement banner. Links in Discord messages, bookmarks and docs still point at
// the classic addresses (/guilds/<key>/tickets/5, /account, /health ...), so a browser visit to one of
// them is sent to the same page under /v2. Only plain browser page visits are redirected: never a
// POST, an htmx fragment, a JSON/API caller, a monitor reading /health, or a download. A person who
// chose the classic dashboard (/?classic=1) is left alone.
//
// "Chose classic" is lib/classicChoice.js (a session flag, or a cookie in open mode).
import { v2Build } from '../routes/v2Client.js';
import { isBrowserPageVisit, prefersClassic } from '../lib/classicChoice.js';

// A server's key in a URL: a Discord id, or `fluxer:<id>` (the colon may arrive as %3A).
const KEY = '((?:fluxer:)?\\d{17,20})';
const MODULE = '([a-z0-9][a-z0-9_-]{0,63})';
// The editors inside a module's classic page (an item of a list: /m/reminders/r/3, /m/roles/rr/new ...).
// The new dashboard edits those inside the module's own page.
const MODULE_ITEM = '(?:r|s|w|hub|rr|sb|cmd)';

/**
 * The mapping table: classic path -> path in the new dashboard (under /v2).
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
  // A server's pages.
  { from: '/guilds/:key', to: (m) => `/guilds/${m[1]}` },
  { from: '/guilds/:key/overview', to: (m) => `/guilds/${m[1]}` },
  { from: '/guilds/:key/settings', to: (m) => `/guilds/${m[1]}/settings` },
  { from: '/guilds/:key/general', to: (m) => `/guilds/${m[1]}/settings` },
  // ?user= is the member a lookup was for.
  { from: '/guilds/:key/member-data', to: (m) => `/guilds/${m[1]}/member-data`, query: ['user'] },
  // Per-server command settings are a tab on the Moderation page.
  { from: '/guilds/:key/commands', to: (m) => `/guilds/${m[1]}/moderation/commands` },
  { from: '/guilds/:key/moderation', to: (m) => `/guilds/${m[1]}/moderation` },
  { from: '/guilds/:key/appeals', to: (m) => `/guilds/${m[1]}/appeals` },
  { from: '/guilds/:key/leaderboard', to: (m) => `/guilds/${m[1]}/leaderboard` },
  { from: '/guilds/:key/insights', to: (m) => `/guilds/${m[1]}/insights` },
  { from: '/guilds/:key/audit', to: (m) => `/guilds/${m[1]}/audit` },
  { from: '/guilds/:key/tickets', to: (m) => `/guilds/${m[1]}/tickets` },
  { from: '/guilds/:key/tickets/:ticketId', to: (m) => `/guilds/${m[1]}/tickets/${m[2]}` },
  { from: '/guilds/:key/messages', to: (m) => `/guilds/${m[1]}/messages` },
  { from: '/guilds/:key/messages/:id', to: (m) => `/guilds/${m[1]}/messages/${m[2]}` },
  { from: '/guilds/:key/m/:moduleId', to: (m) => `/guilds/${m[1]}/m/${m[2]}` },
  { from: '/guilds/:key/m/:moduleId/<item>/...', to: (m) => `/guilds/${m[1]}/m/${m[2]}` },
].map((entry) => ({ ...entry, pattern: patternFor(entry.from) }));

function patternFor(from) {
  const source = from
    .replace(':key', KEY)
    .replace(':ticketId', '(\\d{1,12})')
    .replace(':moduleId', MODULE)
    .replace(':id', '(\\d{1,12}|new)')
    .replace('<item>/...', `${MODULE_ITEM}(?:/[A-Za-z0-9_-]{1,64})*`);
  return new RegExp(`^${source}/?$`, 'i');
}

/**
 * The new-dashboard address for a classic page address, or null when the page has no counterpart
 * (a download, a form post target, an unknown address).
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
    // Keys and module ids are canonical in lower case; the new dashboard's routes are case-sensitive.
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

/** @type {import('express').RequestHandler} */
export function classicRedirect(req, res, next) {
  if (!isBrowserPageVisit(req) || prefersClassic(req) || !v2Build.exists()) return next();
  const target = v2PathFor(req.path, req.query);
  if (!target) return next();
  return res.redirect(target);
}
