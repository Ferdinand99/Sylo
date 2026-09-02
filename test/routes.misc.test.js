import { startWebApp, post } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (p, headers) => fetch(app.base + p, { headers, redirect: 'manual' });

// --- / and /health ----------------------------------------------------------

test('GET / sends you to the active guild dashboard', async () => {
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/guilds\/.+\/overview$/);
});

test('GET /health as a monitor returns the JSON status body', async () => {
  const res = await get('/health', { accept: 'application/json' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.discord.ready, true);
  assert.equal(body.discord.guilds, 1);
  assert.equal(typeof body.uptimeSeconds, 'number');
});

test('GET /health as a browser renders the status page', async () => {
  const res = await get('/health', { accept: 'text/html' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /backup/i);
});

test('POST /health/backups creates a snapshot', async () => {
  const res = await post(app.base, '/health/backups', {});
  assert.ok([200, 302].includes(res.status), `unexpected ${res.status}`);
});

// --- /settings (Bot Personalizer) -----------------------------------------

test('GET /settings renders the identity + presence forms', async () => {
  const res = await get('/settings');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Bot Personalizer|Identity|Presence/i);
});

test('POST /settings/identity with no changes says "nothing to change"', async () => {
  const res = await post(app.base, '/settings/identity', {});
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /ok=1/);
});

test('POST /settings/identity rejects a 1-character username', async () => {
  const res = await post(app.base, '/settings/identity', { username: 'x' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /ok=0/);
});

test('POST /settings/presence saves', async () => {
  const res = await post(app.base, '/settings/presence', {
    status: 'idle',
    type: 'Watching',
    text: 'the server',
  });
  assert.equal(res.status, 302);
});

// --- /commands and /stats -------------------------------------------------

test('GET /commands lists the registered slash commands', async () => {
  const res = await get('/commands');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /ping/);
  assert.match(html, /ban/);
});

test('GET /stats renders the cache table', async () => {
  const res = await get('/stats');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});

// --- public: leaderboard / verify / appeal --------------------------------

test('GET /leaderboard/:id renders when leveling is enabled', async () => {
  const { setGuildModule } = await import('../src/db/modules.js');
  setGuildModule(GID, 'leveling', { enabled: true });
  const res = await get(`/leaderboard/${GID}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});

test('GET /leaderboard/:id 404s when leveling is off', async () => {
  const { setGuildModule } = await import('../src/db/modules.js');
  setGuildModule(GID, 'leveling', { enabled: false });
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

// --- per-guild tickets + messages list pages -----------------------------

test('GET /guilds/:id/tickets renders the list', async () => {
  const res = await get(`/guilds/${GID}/tickets`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ticket/i);
});

test('GET /guilds/:id/messages renders the composed-message list', async () => {
  const res = await get(`/guilds/${GID}/messages`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});

test('GET /guilds/:id/messages/new renders the embed builder', async () => {
  const res = await get(`/guilds/${GID}/messages/new`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /mb-form|embed/i);
});

test('POST /guilds/:id/messages/new saves a draft', async () => {
  const res = await post(app.base, `/guilds/${GID}/messages/new`, {
    name: 'Harness draft',
    action: 'save',
    spec: JSON.stringify({ content: 'hello from the harness' }),
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/messages\/\d+\?msg=saved/);
});

test('POST /guilds/:id/tickets/:id/close on an unknown ticket bounces to the list', async () => {
  const res = await post(app.base, `/guilds/${GID}/tickets/999999/close`, {});
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/guilds\/[^/]+\/tickets$/);
});
