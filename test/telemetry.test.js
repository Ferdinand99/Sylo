import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsn, telemetryScript, telemetrySettings } from '../src/web/lib/telemetry.js';
import { browser, startOAuthApp } from './helpers/oauthApp.js';

const DSN = 'https://f04dcbeafd74f7a73da598f91d152c1f@kestrel.example.com/2';

test('parseDsn takes a DSN and refuses anything else', () => {
  assert.deepEqual(parseDsn(DSN), {
    dsn: DSN,
    key: 'f04dcbeafd74f7a73da598f91d152c1f',
    origin: 'https://kestrel.example.com',
    envelope: 'https://kestrel.example.com/api/2/envelope/',
  });
  assert.equal(
    parseDsn('https://f04dcbeafd74f7a73da598f91d152c1f@sentry.example.com/sub/42')?.envelope,
    'https://sentry.example.com/sub/api/42/envelope/'
  );
  for (const bad of [
    null,
    '',
    'not a url',
    'https://kestrel.example.com/2', // no key
    'https://f04dcbeafd74f7a73da598f91d152c1f@kestrel.example.com/', // no project
    'https://f04dcbeafd74f7a73da598f91d152c1f:secret@kestrel.example.com/2', // a secret key
    'ftp://f04dcbeafd74f7a73da598f91d152c1f@kestrel.example.com/2',
    'https://not-hex@kestrel.example.com/2',
  ]) {
    assert.equal(parseDsn(bad), null, String(bad));
  }
});

test('without a DSN the script does nothing', () => {
  const settings = telemetrySettings({
    dsn: null,
    visitStats: true,
    environment: 'production',
    release: 'sylo@1.0.0',
  });
  assert.equal(settings, null);
  const script = telemetryScript(settings);
  assert.doesNotMatch(script, /Sentry|k\.js|load\(/);
});

test('with a DSN the script reports errors, and counts visits only when asked', () => {
  const base = { dsn: DSN, environment: 'production', release: 'sylo@4.8.1' };
  const errorsOnly = telemetryScript(telemetrySettings({ ...base, visitStats: false }));
  assert.match(errorsOnly, /\/vendor\/sentry\.min\.js/);
  assert.match(errorsOnly, /"release":"sylo@4\.8\.1"/);
  assert.match(errorsOnly, /component: 'dashboard'/);
  assert.match(errorsOnly, /sendDefaultPii: false/);
  // The page address (query and fragment carry OAuth codes and link tokens) is scrubbed.
  assert.match(errorsOnly, /beforeSend: function \(event\)/);
  assert.match(errorsOnly, /beforeBreadcrumb: scrubCrumb/);
  assert.match(errorsOnly, /denyUrls:/);
  assert.match(errorsOnly, /"visits":null/);

  const withVisits = telemetrySettings({ ...base, visitStats: true });
  assert.deepEqual(withVisits.visits, {
    src: 'https://kestrel.example.com/js/k.js',
    key: 'f04dcbeafd74f7a73da598f91d152c1f',
  });
});

test('the settings cannot break out of the script', () => {
  const script = telemetryScript(
    telemetrySettings({
      dsn: DSN,
      visitStats: false,
      environment: '</script><script>alert(1)</script>',
      release: 'x',
    })
  );
  assert.doesNotMatch(script, /<\/script>/);
});

test('/telemetry.js is served before sign-in and is off by default', async () => {
  await startOAuthApp();
  const res = await browser().get('/telemetry.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /off on this instance/);
});

test('the generated script scrubs query strings and fragments from reports and breadcrumbs', async () => {
  const { runInNewContext } = await import('node:vm');
  const script = telemetryScript(
    telemetrySettings({ dsn: DSN, visitStats: false, environment: 'production', release: 'sylo@1' })
  );
  let init;
  const window = {
    location: { href: 'https://sylo.example.com/auth/error?code=SECRET&state=ST' },
    Sentry: { init: (options) => (init = options) },
  };
  const document = {
    head: { appendChild: (el) => el.onload?.() },
    createElement: () => ({ setAttribute() {} }),
  };
  runInNewContext(script, { window, document, URL });

  assert.equal(typeof init.beforeSend, 'function', 'the SDK is started with a beforeSend');
  const event = init.beforeSend({
    request: {
      url: 'https://sylo.example.com/auth/error?code=SECRET&state=ST#frag',
      query_string: 'code=SECRET',
      headers: { Referer: 'https://x/?token=T', Cookie: 'sid=1', 'User-Agent': 'ua' },
    },
    breadcrumbs: [
      { category: 'navigation', data: { from: '/a?code=1', to: '/b?t=2#x' } },
      { category: 'fetch', data: { url: 'https://sylo.example.com/api/v2/x?token=T' } },
    ],
  });
  assert.equal(event.request.url, 'https://sylo.example.com/auth/error');
  assert.equal(event.request.query_string, undefined);
  assert.deepEqual(event.request.headers, { 'User-Agent': 'ua' });
  assert.equal(event.breadcrumbs[0].data.from, 'https://sylo.example.com/a');
  assert.equal(event.breadcrumbs[0].data.to, 'https://sylo.example.com/b');
  assert.equal(event.breadcrumbs[1].data.url, 'https://sylo.example.com/api/v2/x');
  // The breadcrumb hook scrubs as events are recorded, and the Sentry v8 shape ({ values }) too.
  assert.equal(init.beforeBreadcrumb({ data: { url: '/p?code=1' } }).data.url, 'https://sylo.example.com/p');
  const v8 = init.beforeSend({ breadcrumbs: { values: [{ data: { url: '/q?t=1' } }] } });
  assert.equal(v8.breadcrumbs.values[0].data.url, 'https://sylo.example.com/q');
});
