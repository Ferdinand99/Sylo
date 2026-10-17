// One log line per HTTP response — "GET /guilds/123/overview 200 12.4ms" — at
// debug level, so it is silent unless LOG_LEVEL=debug. It also feeds
// sylo_http_requests_total{route,status}, bucketed by the first path segment (from a fixed
// list) so the label set stays small no matter what paths come through.
//
// Mounted first in createApp() so it sees every request, including static files;
// the healthcheck and static assets are filtered out because they fire
// constantly and carry no signal.
import { log } from '../../lib/log.js';
import { inc } from '../../lib/metrics.js';

const SKIP = /^\/(?:health$|assets\/|.*\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$)/;

// The first path segments the app serves. Anything else is "other": a label per random path
// would add a counter for every request an anonymous client makes, kept forever.
const ROUTES = new Set([
  'account',
  'api',
  'appeal',
  'auth',
  'commands',
  'guilds',
  'lb',
  'leaderboard',
  'metrics',
  'roadmap',
  'settings',
  'stats',
  'v2',
  'verify',
  'webhooks',
]);

/** Collapse a path to its first segment: "/guilds/123/x" -> "/guilds"; unknown -> "other". */
function bucket(path) {
  const seg = (path.split('/', 2)[1] ?? '').toLowerCase();
  if (!seg) return '/';
  return ROUTES.has(seg) ? `/${seg}` : 'other';
}

/** @type {import('express').RequestHandler} */
export function requestLog(req, res, next) {
  // Capture up front: sub-routers rewrite req.url while they run, so reading the
  // path from the res 'finish' handler can see a stale/stripped value.
  const path = (req.originalUrl || req.url).split('?', 1)[0];
  if (SKIP.test(path)) return next();
  const method = req.method;
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    inc('sylo_http_requests_total', { route: bucket(path), status: res.statusCode });
    log.debug('web', `${method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
