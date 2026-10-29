// Express app for the Sylo web dashboard.
// Runs in the same process as the bot and reads live bot state from ../runtime.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isPrivateAddress } from '../lib/safeFetch.js';
import { isLocalHostname } from '../lib/localHost.js';
import { LimitError } from '../lib/limits.js';
import { RoleGrantError } from './middleware/roleGrants.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { mountAuth, requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { csrf } from './middleware/csrf.js';
import { classicRedirect } from './middleware/classicRedirect.js';
import { ownerOnlyModules } from './middleware/ownerOnlyModules.js';
import { mobileApiRouter, mobileAuthRouter } from './routes/mobile.js';
import { createPushRelayRouter } from './routes/pushRelay.js';
import { defaultApnsClient } from '../lib/push.js';
import { requestLog } from './middleware/requestLog.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import leaderboardRouter, { vanityRouter } from './routes/leaderboard.js';
import quotesRouter from './routes/quotes.js';
import verifyRouter from './routes/verify.js';
import appealRouter from './routes/appeal.js';
import githubWebhookRouter from './routes/githubWebhook.js';
import youtubeWebhookRouter from './routes/youtubeWebhook.js';
import { websubEnabled } from '../modules/youtubeWebsub.js';
import v2ApiRouter from './routes/v2Api.js';
import v2ClientRouter, { v2Build, v2PublicClientRouter } from './routes/v2Client.js';
import v2PublicRouter from './routes/v2Public.js';
import telemetryRouter from './routes/telemetry.js';
import { securityHeaders } from './lib/securityHeaders.js';
import roadmapRouter from './routes/roadmap.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Express's `trust proxy`: which peers may tell us the client's address (X-Forwarded-For)
 * and protocol. Behind a reverse proxy (DASHBOARD_URL set) that is one hop, and only a peer on
 * this machine or the local network: if the port is also reachable from the internet, a
 * client talking to it directly must not pick its own address. TRUST_PROXY overrides this
 * (`false`, a hop count, or addresses/subnets as Express takes them).
 */
export function trustProxySetting({ dashboardUrl, trustProxy }) {
  if (trustProxy != null) {
    if (/^(false|no|off|0)$/i.test(trustProxy)) return false;
    if (/^\d+$/.test(trustProxy)) return Number(trustProxy);
    return trustProxy;
  }
  if (!dashboardUrl) return false;
  return (addr, i) => i === 0 && isPrivateAddress(addr);
}

// Hosts open mode answers on (see refuseRemoteHostsInOpenMode).

/** In open mode, is this Host a local name or address? */
function isLocalHost(hostHeader) {
  // The Host header itself, without its port: never X-Forwarded-Host (req.hostname), which a
  // rebound page's script can set when it reaches Sylo from a trusted (private) address.
  const raw = String(hostHeader ?? '')
    .trim()
    .toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  if (!host) return false;
  if (isLocalHostname(host)) return true; // an address typed by hand, as on a LAN, or a local name
  try {
    return Boolean(config.dashboardUrl) && new URL(config.dashboardUrl).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * Open mode has no login, so a web page could use the dashboard of anyone on its visitor's
 * network through DNS rebinding: its own domain re-pointed at a LAN address, where Origin and
 * Host are both the attacker's name and the CSRF origin check passes. Answer only on local
 * names and IP addresses, and on DASHBOARD_URL's host.
 */
export function refuseRemoteHostsInOpenMode(req, res, next) {
  if (config.authEnabled || isLocalHost(req.get('host'))) return next();
  res
    .status(403)
    .type('text/plain')
    .send(
      'This Sylo dashboard has no login (open mode), so it only answers on local addresses. ' +
        'Set DASHBOARD_URL to the address you use, or turn on a login.'
    );
}

/** A path with a broken %-escape cannot be routed or decoded: a 400, before anything throws. */
function refuseMalformedPaths(req, res, next) {
  try {
    decodeURIComponent(req.path);
  } catch {
    return res.status(400).type('text/plain').send('Malformed URL.');
  }
  next();
}

/**
 * Where a request went, for logs: the mount path and route pattern ("/webhooks/github/:token"),
 * never the path the client sent. Mount segments that are not plain words (ids) are masked.
 */
export function routeLabel(req) {
  const mount = String(req.baseUrl ?? '')
    .split('/')
    .map((seg) => (seg === '' || /^[a-z][a-z0-9_-]{0,30}$/i.test(seg) ? seg : ':id'))
    .join('/');
  return `${mount}${req.route?.path ?? '(unmatched)'}`;
}

/** Build (but do not start) the Express app. Exposed for testing. */
export function createApp() {
  const app = express();

  app.set('trust proxy', trustProxySetting(config));
  // A proxy that reaches Sylo from a public address (Cloudflare straight to the port, a proxy on
  // another server) is not trusted by default: say so once, since logins then fail quietly
  // (no secure cookie over what looks like http) and every client shares one rate limit.
  let warnedProxy = false;
  app.use((req, _res, next) => {
    if (
      !warnedProxy &&
      config.dashboardUrl &&
      config.trustProxy == null &&
      req.headers['x-forwarded-for'] &&
      !isPrivateAddress(String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''))
    ) {
      warnedProxy = true;
      log.warn(
        'web',
        `X-Forwarded-For arrived from ${req.socket.remoteAddress}, a public address, and was ignored. ` +
          'If that is your reverse proxy, set TRUST_PROXY to its address (or a hop count).'
      );
    }
    next();
  });

  app.set('view engine', 'ejs');
  app.set('views', join(here, 'views'));
  app.disable('x-powered-by');

  // First in the chain: per-request debug log + the HTTP request counter.
  app.use(requestLog);
  // No page may be framed by another site (clickjacking), only the dashboard's own scripts and
  // styles run (Content-Security-Policy), https is remembered (HSTS, under an https
  // DASHBOARD_URL), the browser must not guess content types, and other sites get only the
  // origin as referrer. See lib/securityHeaders.js.
  app.use(securityHeaders(config));
  app.use(refuseMalformedPaths);
  app.use(refuseRemoteHostsInOpenMode);

  // Ahead of the global body parsers below: this route needs the exact raw
  // request bytes to verify GitHub's HMAC signature, and a body parser can
  // only consume the request stream once. It's also unauthenticated by
  // design (GitHub can't carry a dashboard session) — signature verification
  // inside the route is what stands in for auth here.
  app.use('/webhooks/github', githubWebhookRouter);
  // YouTube's WebSub hub calls back here (verification GET, Atom POST signed per subscription).
  // Same reasoning as above, and only with a public https DASHBOARD_URL: without one no hub could
  // reach it and nothing is ever subscribed. It stays behind the open-mode host refusal: the hub
  // calls the DASHBOARD_URL host, which that refusal lets through.
  if (websubEnabled()) app.use('/webhooks/youtube', youtubeWebhookRouter);

  app.use(express.static(join(here, 'public')));
  // Error reports and visit counts for the dashboard and the public pages; does nothing unless configured.
  app.use('/telemetry.js', telemetryRouter);
  // Per-client ceiling on everything below. It runs ahead of the body parsers: a request whose
  // body fails to parse (too large, broken JSON) is answered by the parser's own error, so a
  // limiter behind them would never count it. Generous for normal clicking, but stops a stuck
  // script, a flood of junk requests or a compromised session from hammering config saves,
  // backups or "send as bot". Unauthenticated traffic is capped too, not just signed-in sessions.
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(express.json({ limit: '256kb' }));
  // Express 5 leaves req.body undefined for a request without a body; handlers read fields.
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });

  // Session + res.locals + /auth/* routes. No-op guards in open mode.
  mountAuth(app);

  // CSRF protection for state-changing requests (a no-op in open mode, which has
  // no session). Exempts /auth, /verify and /appeal, which carry signed tokens.
  app.use(csrf);

  // Signing in to the Sylo app: the browser part and the code-for-token exchange. Both run
  // before requireAuth (the exchange is how the app becomes signed in).
  app.use('/auth/mobile', mobileAuthRouter);
  app.use('/api/mobile', mobileApiRouter);
  // The push relay for self-hosted instances, only where the app's APNs key is (the hosted Sylo).
  if (config.apnsEnabled) {
    app.use('/api/push-relay/v1', createPushRelayRouter({ apns: defaultApnsClient() }));
  }

  // Old dashboard addresses (/account, /health, /guilds/<key>/tickets/5 ...) open the matching page
  // in the dashboard (/v2) with a permanent redirect. Ahead of the public /health route: only a
  // browser visit (Accept: text/html) moves, the JSON for monitors stays.
  app.use(classicRedirect);

  // Public routes: healthcheck, metrics, the shareable leaderboard, and member
  // verification.
  app.use('/health', healthRouter);
  app.use('/metrics', rateLimit({ windowMs: 60_000, max: 30 }), metricsRouter);
  app.use('/leaderboard', rateLimit({ windowMs: 60_000, max: 40 }), leaderboardRouter);
  app.use('/lb', rateLimit({ windowMs: 60_000, max: 40 }), vanityRouter);
  app.use('/quotes', rateLimit({ windowMs: 60_000, max: 40 }), quotesRouter);
  app.use('/verify', rateLimit({ windowMs: 60_000, max: 20 }), verifyRouter);
  app.use('/appeal', rateLimit({ windowMs: 60_000, max: 15 }), appealRouter);
  app.use('/roadmap', rateLimit({ windowMs: 60_000, max: 60 }), roadmapRouter);
  // The dashboard's public data (command list, roadmap): read-only, limited like the other public
  // pages. Only /api/v2/public is public; the rest of /api/v2 is mounted after requireAuth.
  app.use('/api/v2/public', rateLimit({ windowMs: 60_000, max: 60 }), v2PublicRouter);

  // The new dashboard's built files and its two public pages (/v2/commands, /v2/roadmap), which
  // work without a session. Every other /v2 path is mounted after requireAuth, below.
  app.use('/v2', v2PublicClientRouter);
  // Everything below requires a signed-in user when auth is enabled.
  app.use(requireAuth);
  app.get('/', (req, res) => res.redirect('/v2'));
  app.use('/api/v2/guilds/:guildId', ownerOnlyModules);
  app.use('/api/v2', v2ApiRouter);
  app.use('/v2', v2ClientRouter);

  // Central error handler — keep the server up, record the error for the dashboard.
  // Express recognises an error handler by its 4-arg signature, so `_next` must
  // be present even though it is unused.
  app.use((err, req, res, _next) => {
    // The person's own doing, not a server error: a per-server ceiling (src/lib/limits.js) or a
    // role they may not hand out (src/web/middleware/roleGrants.js). The reason reaches them as
    // JSON or an error page.
    if (err instanceof LimitError || err instanceof RoleGrantError) {
      const status = err.status;
      const heading = err instanceof LimitError ? 'Limit reached' : 'Role not allowed';
      if (req.originalUrl.startsWith('/api/') || !req.accepts('html')) {
        return res.status(status).json({ error: err.message });
      }
      return res.status(status).render('error', { title: heading, heading, message: err.message });
    }
    // A request the client got wrong, not a server fault: a body over the cap (413) or one that
    // does not parse (400), from the body parsers. Anyone can send these, so they must not reach
    // log.error (dev-log channel, operators' phones, /health): answer and move on.
    const status = err?.status ?? err?.statusCode;
    if (err?.expose === true && Number.isInteger(status) && status >= 400 && status < 500) {
      log.debug('web', `${req.method} ${routeLabel(req)} ${status} ${err.type ?? ''}`.trim());
      if (res.headersSent) return res.end();
      return res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Bad request' });
    }
    // The route pattern, never the raw path: the path is the caller's to choose (a unique message
    // per request) and in a webhook URL it holds a secret token.
    log.error('web', `${req.method} ${routeLabel(req)}`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start the dashboard HTTP server.
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
export function startWeb(port) {
  const app = createApp();
  if (!v2Build.exists()) {
    log.warn('web', 'The dashboard is not built, so /v2 answers 503: run npm run build:v2.');
  }
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      log.info('web', `Dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}
