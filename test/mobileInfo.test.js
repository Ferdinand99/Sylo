// Describing the server to the Sylo app (internal/mobile-api-plan.md, task 6): when someone types
// a server address, the app asks GET /api/mobile/info whether it is a Sylo, whether it can sign
// in there and what this version's app API supports. It is public and says nothing private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { browser, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { version } = createRequire(import.meta.url)('../package.json');
const KEYS = ['apiVersion', 'features', 'login', 'loginProviders', 'name', 'platforms', 'version'];

test('GET /api/mobile/info describes a server with login on, without a cookie or token', async () => {
  const res = await browser().get('/api/mobile/info');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const info = await res.json();
  // pushRelay is there when this Sylo pushes through a relay (the default).
  assert.deepEqual(
    Object.keys(info)
      .filter((k) => k !== 'pushRelay')
      .sort(),
    KEYS
  );
  assert.equal(info.name, 'Sylo');
  assert.equal(info.version, version);
  assert.equal(info.apiVersion, 1);
  assert.equal(info.login, true);
  assert.deepEqual([...info.loginProviders].sort(), ['discord', 'fluxer']);
  assert.deepEqual([...info.platforms].sort(), ['discord', 'fluxer']);
  assert.ok(info.features.includes('app-login'));
  assert.ok(info.features.includes('live-access'));
  assert.ok(info.features.includes('changelog'), 'GET /api/v2/changelog');
  assert.ok(info.features.every((f) => typeof f === 'string'));
});

test('GET /api/mobile/info says nothing about secrets, ids or the dashboard', async () => {
  const body = await (await browser().get('/api/mobile/info')).text();
  for (const secret of [
    process.env.DISCORD_CLIENT_ID,
    process.env.FLUXER_CLIENT_ID,
    process.env.DISCORD_CLIENT_SECRET,
    process.env.FLUXER_CLIENT_SECRET,
    process.env.OWNER_IDS,
    process.env.FLUXER_OWNER_IDS,
    process.env.FLUXER_WEB_URL,
  ]) {
    assert.ok(!body.includes(secret), `leaks ${secret}`);
  }
});

// Config is read once per process, so open mode (no OAuth configured) runs in a child process:
// a Discord-only install with no client secret.
const OPEN_MODE = `
  await import(${JSON.stringify(new URL('./helpers/tmpDb.js', import.meta.url).href)});
  const { createApp } = await import(${JSON.stringify(new URL('../src/web/server.js', import.meta.url).href)});
  const server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/mobile/info');
  console.log(JSON.stringify({ status: res.status, body: await res.text() }));
  process.exit(0);
`;

test('GET /api/mobile/info answers in open mode and says login is unavailable', async () => {
  const env = {
    ...process.env,
    DISCORD_CLIENT_SECRET: '',
    FLUXER_CLIENT_SECRET: '',
    FLUXER_TOKEN: '',
    FLUXER_CLIENT_ID: '',
    DASHBOARD_URL: '',
  };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', OPEN_MODE],
    { env, timeout: 30_000 }
  );
  const { status, body } = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(status, 200);
  const info = JSON.parse(body);
  assert.deepEqual(Object.keys(info).sort(), KEYS);
  assert.equal(info.login, false);
  assert.deepEqual(info.loginProviders, []);
  assert.deepEqual(info.platforms, ['discord']);
  assert.equal(info.apiVersion, 1);
  assert.ok(!info.features.includes('push'), 'no app sign-in, so no push either');
  assert.ok(info.features.includes('changelog'), 'the changelog does not need a sign-in in open mode');
});
