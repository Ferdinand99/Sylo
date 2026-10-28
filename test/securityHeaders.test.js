// The Content-Security-Policy and HSTS every page carries (src/web/lib/securityHeaders.js).
// The policy is built from config, so the variants are checked on a bare Express app with a
// config object; the real app (one process, one config) checks that every page carries it.
// Env first, then dynamic imports: config.js reads the environment once, when it loads.
import './helpers/tmpDb.js';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TURNSTILE_SITE_KEY = 'site-key';
process.env.TURNSTILE_SECRET_KEY = 'secret-key';
process.env.DASHBOARD_ERROR_DSN = 'https://f04dcbeafd74f7a73da598f91d152c1f@kestrel.example.com/2';
process.env.DASHBOARD_VISIT_STATS = '1';

const { buildCsp, securityHeaders, TURNSTILE_SOURCES } = await import('../src/web/lib/securityHeaders.js');
const { startWebApp } = await import('./helpers/webApp.js');
const { signVerifyToken } = await import('../src/modules/verification.js');
const { setGuildModule } = await import('../src/db/modules.js');

const DSN = process.env.DASHBOARD_ERROR_DSN;
const KESTREL = 'https://kestrel.example.com';
const CLOUDFLARE = 'https://challenges.cloudflare.com';

/** The directives of a policy, by name. */
function parse(policy) {
  return Object.fromEntries(
    policy.split('; ').map((d) => {
      const [name, ...sources] = d.split(' ');
      return [name, sources];
    })
  );
}

/** Runs `fn(baseUrl)` against a bare app that has only the security headers (and `onRoute`). */
async function withApp(config, onRoute, fn) {
  const app = express();
  app.use(securityHeaders(config));
  app.get('/', (req, res) => {
    onRoute?.(req, res);
    res.send('ok');
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** The response headers a request to a bare app with this config gets. */
const headersFor = (config) => withApp(config, null, async (url) => (await fetch(url)).headers);

test('the default policy allows only the dashboard itself, https images and nothing else', () => {
  const csp = buildCsp();
  assert.equal(
    csp,
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self' sylo:",
    ].join('; ')
  );
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

test('buildCsp adds the error endpoint to connect-src only, and Kestrel to script-src too', () => {
  const dsnOnly = parse(buildCsp({ dsnOrigin: KESTREL }));
  assert.deepEqual(dsnOnly['connect-src'], ["'self'", KESTREL]);
  assert.deepEqual(dsnOnly['script-src'], ["'self'"]);

  const both = parse(buildCsp({ dsnOrigin: KESTREL, kestrelOrigin: KESTREL }));
  assert.deepEqual(both['connect-src'], ["'self'", KESTREL]); // not listed twice
  assert.deepEqual(both['script-src'], ["'self'", KESTREL]);
});

test('buildCsp merges extra sources into a directive and can add a new one', () => {
  const policy = parse(buildCsp({ extra: TURNSTILE_SOURCES }));
  assert.deepEqual(policy['script-src'], ["'self'", CLOUDFLARE]);
  assert.deepEqual(policy['connect-src'], ["'self'", CLOUDFLARE]);
  assert.deepEqual(policy['frame-src'], ["'self'", CLOUDFLARE]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
});

test('without a usable DSN nothing is added', async () => {
  for (const dashboardErrorDsn of [null, 'not a dsn']) {
    const headers = await headersFor({ dashboardErrorDsn, dashboardVisitStats: true });
    assert.equal(headers.get('content-security-policy'), buildCsp());
  }
});

test('with a DSN, error reports may go to its host; with visit counts, k.js may load from it', async () => {
  const errors = await headersFor({ dashboardErrorDsn: DSN, dashboardVisitStats: false });
  const policy = parse(errors.get('content-security-policy'));
  assert.deepEqual(policy['connect-src'], ["'self'", KESTREL]);
  assert.deepEqual(policy['script-src'], ["'self'"]);

  const visits = await headersFor({ dashboardErrorDsn: DSN, dashboardVisitStats: true });
  assert.equal(
    visits.get('content-security-policy'),
    buildCsp({ dsnOrigin: KESTREL, kestrelOrigin: KESTREL })
  );
  assert.deepEqual(parse(visits.get('content-security-policy'))['script-src'], ["'self'", KESTREL]);
});

test('HSTS is sent only when DASHBOARD_URL is https, without includeSubDomains', async () => {
  const https = await headersFor({ dashboardUrl: 'https://sylo.example.com' });
  assert.equal(https.get('strict-transport-security'), 'max-age=15552000');
  for (const dashboardUrl of ['http://sylo.example.com', 'http://localhost:3000', null, undefined]) {
    const headers = await headersFor({ dashboardUrl });
    assert.equal(headers.get('strict-transport-security'), null, String(dashboardUrl));
  }
});

test('CSP_REPORT_ONLY switches to the Report-Only header', async () => {
  const enforcing = await headersFor({});
  assert.ok(enforcing.get('content-security-policy'));
  assert.equal(enforcing.get('content-security-policy-report-only'), null);

  const reporting = await headersFor({ cspReportOnly: true, dashboardErrorDsn: DSN });
  assert.equal(reporting.get('content-security-policy'), null);
  assert.equal(reporting.get('content-security-policy-report-only'), buildCsp({ dsnOrigin: KESTREL }));
});

test('the other headers stay', async () => {
  const headers = await headersFor({});
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('extendCsp keeps the header name and the config origins', async () => {
  const config = { cspReportOnly: true, dashboardErrorDsn: DSN };
  const extend = (_req, res) => res.locals.extendCsp(TURNSTILE_SOURCES);
  await withApp(config, extend, async (url) => {
    const res = await fetch(url);
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(
      res.headers.get('content-security-policy-report-only'),
      buildCsp({ dsnOrigin: KESTREL, extra: TURNSTILE_SOURCES })
    );
  });
});

// --- the real app ---------------------------------------------------------------------------

const { base, guild, close } = await startWebApp();
test.after(close);

// The same policy on every page, with the DSN and Kestrel from the environment above.
const APP_POLICY = buildCsp({ dsnOrigin: KESTREL, kestrelOrigin: KESTREL });

test('every public page and the dashboard shell carry the policy', async () => {
  const paths = [
    '/auth/login',
    '/auth/mobile/confirm', // the error page, signed out
    `/verify/${guild.id}`, // the error page: no token
    `/appeal/${guild.id}`,
    `/leaderboard/${guild.id}`,
    '/health',
    '/telemetry.js',
    '/v2/roadmap',
    '/v2/commands',
    '/v2/',
  ];
  for (const path of paths) {
    const res = await fetch(base + path, { redirect: 'manual' });
    assert.equal(res.headers.get('content-security-policy'), APP_POLICY, path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    await res.arrayBuffer();
  }
});

test('the verify page, and only it, may load Turnstile', async () => {
  await setGuildModule(guild.id, 'verification', { enabled: true });
  const token = signVerifyToken(guild.id, '123456789012345678');
  const res = await fetch(`${base}/verify/${guild.id}?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /challenges\.cloudflare\.com\/turnstile/);
  const policy = parse(res.headers.get('content-security-policy'));
  assert.deepEqual(policy['script-src'], ["'self'", KESTREL, CLOUDFLARE]);
  assert.deepEqual(policy['frame-src'], ["'self'", CLOUDFLARE]);
  assert.deepEqual(policy['connect-src'], ["'self'", KESTREL, CLOUDFLARE]);

  const other = await fetch(`${base}/leaderboard/${guild.id}`);
  assert.doesNotMatch(other.headers.get('content-security-policy'), /cloudflare/);
  const bad = await fetch(`${base}/verify/${guild.id}?t=nope`);
  assert.doesNotMatch(bad.headers.get('content-security-policy'), /cloudflare/);
});

test('the dashboard page has no inline script, style or event handler', () => {
  const html = readFileSync(new URL('../web-v2/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'inline script');
  assert.doesNotMatch(html, /<style[\s>]/i, 'inline style');
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i, 'inline attribute');
  // The theme script is a plain blocking script ahead of the module script, so it still runs
  // before first paint.
  assert.ok(html.indexOf('<script src="/v2/theme.js"></script>') > 0);
  assert.ok(html.indexOf('/v2/theme.js') < html.indexOf('type="module"'));
});
