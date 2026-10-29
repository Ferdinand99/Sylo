import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (p, headers) => fetch(app.base + p, { headers, redirect: 'manual' });

test('GET /health as a monitor returns the JSON status body', async () => {
  const res = await get('/health', { accept: 'application/json' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.discord.ready, true);
  assert.equal(body.discord.guilds, 1);
  assert.equal(typeof body.uptimeSeconds, 'number');
  // 3.7.0 observability additions
  assert.ok('gatewayPingHistory' in body.discord);
  assert.ok(Array.isArray(body.discord.gatewayPingHistory));
  assert.equal(typeof body.errorsByScope, 'object');
  assert.ok(Array.isArray(body.commands));
});

test('GET /metrics serves Prometheus text with the core gauges', async () => {
  const res = await get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  const text = await res.text();
  assert.match(text, /^# TYPE sylo_up gauge$/m);
  assert.match(text, /^sylo_up 1$/m);
  assert.match(text, /^sylo_guilds 1$/m);
  assert.match(text, /^sylo_uptime_seconds \d+$/m);
  assert.match(text, /^sylo_gateway_ping_ms -?\d+$/m);
  assert.match(text, /^sylo_module_enabled\{module="welcome"\} \d+$/m);
});

test('GET /metrics reflects the HTTP request counter', async () => {
  await get('/leaderboard/000000000000000000');
  // the counter is bumped in the server's res 'finish' handler — let it settle
  await new Promise((r) => setTimeout(r, 20));
  const text = await (await get('/metrics')).text();
  assert.match(text, /^# TYPE sylo_http_requests_total counter$/m);
  assert.match(text, /sylo_http_requests_total\{route="\/leaderboard",status="404"\} \d+/);
});

// --- public: leaderboard / verify / appeal --------------------------------

test('GET /leaderboard/:id renders when leveling is enabled', async () => {
  const { setGuildModule } = await import('../src/db/modules.js');
  await setGuildModule(GID, 'leveling', { enabled: true });
  const res = await get(`/leaderboard/${GID}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});

test('GET /leaderboard/:id 404s when leveling is off', async () => {
  const { setGuildModule } = await import('../src/db/modules.js');
  await setGuildModule(GID, 'leveling', { enabled: false });
  const res = await get(`/leaderboard/${GID}`);
  assert.equal(res.status, 404);
});

test('GET /leaderboard/:id 404s for an unknown guild', async () => {
  const res = await get('/leaderboard/000000000000000000');
  assert.equal(res.status, 404);
});

test('GET /verify/:id with a bad token shows the invalid-link page', async () => {
  const res = await get(`/verify/${GID}?t=not-a-token`);
  assert.ok([200, 400].includes(res.status));
  assert.match(await res.text(), /invalid or has expired/i);
});

test('GET /appeal/:id with a bad token shows the error page', async () => {
  const res = await get(`/appeal/${GID}?t=nope`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /<!doctype html>/i);
});
