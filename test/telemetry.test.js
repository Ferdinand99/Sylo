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
