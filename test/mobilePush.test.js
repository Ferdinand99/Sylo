// Push notifications for the Sylo app, the instance's side (internal/push-notifications-plan.md,
// task 2): /api/mobile/push registers, removes and mutes, for app tokens only; /api/mobile/info
// says "push" when the instance can send. Relay mode runs against the real relay router with a
// fake APNs client; direct mode with a fake APNs client.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  D_GUILD,
  F_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity, signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, apiTokenPush } = await import('../src/db/apiTokens.js');
const { findRelayRegistration } = await import('../src/db/pushRelay.js');
const { configurePush } = await import('../src/lib/push.js');
const { createPushRelayRouter } = await import('../src/web/routes/pushRelay.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { config } = await import('../src/config.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

// A relay like the hosted one, on its own port, with Apple faked.
const apnsCalls = [];
const fakeApns = {
  send: async (msg) => {
    apnsCalls.push(msg);
    return { status: 'ok' };
  },
};
const relayApp = express();
relayApp.use(express.json());
let relayDown = false;
relayApp.use((req, res, next) => (relayDown ? res.status(503).end() : next()));
relayApp.use('/api/push-relay/v1', createPushRelayRouter({ apns: fakeApns }));
const relayServer = await new Promise((resolve) => {
  const s = relayApp.listen(0, () => resolve(s));
});
const RELAY = `http://127.0.0.1:${relayServer.address().port}`;
test.after(() => {
  relayServer.closeAllConnections?.();
  relayServer.close();
});

const DEVICE = 'ab'.repeat(32);
const relayMode = () => configurePush({ relayUrl: RELAY, apns: null, deliver: null });

/** Someone signed in to the app, with Manage Server in D_GUILD; their token (and a browser). */
async function person({ manage = true, withBrowser = false } = {}) {
  setProfiles();
  const id = profiles.discord.id;
  let b = null;
  if (withBrowser) {
    b = browser();
    await signIn(b, 'discord');
  } else {
    // Straight to the database: the OAuth round-trip is rate limited to a few sign-ins a minute.
    await signInIdentity({ platform: 'discord', platformUserId: id, guildIds: [D_GUILD] });
  }
  const { accountId } = await findIdentity('discord', id);
  const { id: tokenId, token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  if (manage) {
    guild.members.cache.set(id, {
      id,
      permissions: { has: (p) => p === 'ManageGuild' },
      roles: { cache: { hasAny: () => false } },
    });
  }
  return { id, token, tokenId, b };
}

const app = browser();
const call = (method, path, token, body) =>
  app.get(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const DIRECT = { deviceToken: DEVICE, environment: 'production' };
const register = (token, body) => call('POST', '/api/mobile/push', token, body);

/** What the app does in relay mode: register its device token at the relay itself. */
async function relayToken(deviceToken = DEVICE, instance = 'https://sylo.example.com') {
  const res = await fetch(`${RELAY}/api/push-relay/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceToken, environment: 'production', instance }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).relayToken;
}

/** Wait for a best-effort, not-awaited call to have happened. */
async function eventually(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('it never happened');
}

test.beforeEach(() => {
  relayMode();
  relayDown = false;
  apnsCalls.length = 0;
});
test.after(() => configurePush({ relayUrl: null, apns: undefined, deliver: null }));

test('every push route is for app tokens: 401 signed out, 403 JSON for a browser session', async () => {
  const { b } = await person({ withBrowser: true });
  for (const [method, path] of [
    ['POST', '/api/mobile/push'],
    ['DELETE', '/api/mobile/push'],
    ['GET', '/api/mobile/push'],
    ['PUT', `/api/mobile/push/servers/${D_GUILD}`],
  ]) {
    const anon = await call(method, path, null, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.equal(anon.status, 401, `${method} ${path}`);
    const cookie = await b.get(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.equal(cookie.status, 403, `${method} ${path} with a cookie`);
    assert.match(cookie.headers.get('content-type'), /application\/json/);
    assert.equal(typeof (await cookie.json()).error, 'string');
  }
});

test('POST, relay mode: stores the relay token the app got, and never calls the relay', async () => {
  const { token, tokenId } = await person();
  const relay = await relayToken();
  relayDown = true; // the instance does not need the relay to register
  const res = await register(token, { relayToken: relay, environment: 'development' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const push = await apiTokenPush(tokenId);
  assert.equal(push.relayToken, relay);
  assert.equal(push.deviceToken, null, 'an instance in relay mode never sees a device token');
  assert.equal(push.environment, 'development');
  // DASHBOARD_URL, else the address the app called.
  if (config.dashboardUrl) assert.equal(push.origin, config.dashboardUrl);
  else assert.match(push.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  assert.deepEqual(await (await call('GET', '/api/mobile/push', token)).json(), {
    enabled: true,
    mutedServers: [],
  });
});

test('POST, relay mode: a device token is refused with relay_token_required', async () => {
  const { token, tokenId } = await person();
  const res = await register(token, DIRECT);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'relay_token_required' });
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
});

test('POST, relay mode: a malformed relay token or environment is invalid_push_token', async () => {
  const { token, tokenId } = await person();
  const good = 'A'.repeat(43);
  for (const body of [
    {},
    { relayToken: 'short', environment: 'production' },
    { relayToken: `${good}x`, environment: 'production' },
    { relayToken: `${'A'.repeat(42)}=`, environment: 'production' },
    { relayToken: good, environment: 'staging' },
    { relayToken: 42, environment: 'production' },
  ]) {
    const res = await register(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid_push_token' });
  }
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
});

test('POST again replaces the relay token, and the old one is unregistered at the relay', async () => {
  const { token, tokenId } = await person();
  const first = await relayToken('cd'.repeat(32), 'https://one.example.com');
  const second = await relayToken('cd'.repeat(32), 'https://two.example.com');
  await register(token, { relayToken: first, environment: 'production' });
  await register(token, { relayToken: second, environment: 'production' });
  assert.equal((await apiTokenPush(tokenId)).relayToken, second);
  await eventually(async () => (await findRelayRegistration(first)) === null);
  assert.ok(await findRelayRegistration(second));
});

test('POST: 503 push_unavailable when the instance cannot push', async () => {
  const { token } = await person();
  configurePush({ relayUrl: null, apns: null });
  for (const body of [DIRECT, { relayToken: 'A'.repeat(43), environment: 'production' }]) {
    const res = await register(token, body);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'push_unavailable' });
  }
  assert.deepEqual(await (await call('GET', '/api/mobile/push', token)).json(), {
    enabled: false,
    mutedServers: [],
  });
});

test('POST, direct mode (the instance holds the APNs key): a device token, never a relay token', async () => {
  const { token, tokenId } = await person();
  configurePush({ apns: fakeApns });
  let res = await register(token, { relayToken: 'A'.repeat(43), environment: 'production' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'device_token_required' });

  res = await register(token, { deviceToken: DEVICE.toUpperCase(), environment: 'production' });
  assert.equal(res.status, 200);
  const push = await apiTokenPush(tokenId);
  assert.equal(push.deviceToken, DEVICE, 'lower-cased');
  assert.equal(push.relayToken, null);
  assert.equal(push.environment, 'production');

  for (const body of [
    {},
    { deviceToken: 'xyz', environment: 'production' },
    { deviceToken: 'a'.repeat(63), environment: 'production' },
    { deviceToken: 'a'.repeat(201), environment: 'production' },
    { deviceToken: DEVICE, environment: 'staging' },
  ]) {
    assert.deepEqual(await (await register(token, body)).json(), { error: 'invalid_push_token' });
  }
});

test('DELETE turns push off and unregisters at the relay', async () => {
  const { token, tokenId } = await person();
  const relay = await relayToken('ef'.repeat(32));
  await register(token, { relayToken: relay, environment: 'production' });
  const res = await call('DELETE', '/api/mobile/push', token);
  assert.equal(res.status, 204);
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
  await eventually(async () => (await findRelayRegistration(relay)) === null);
  assert.equal((await (await call('GET', '/api/mobile/push', token)).json()).enabled, false);
  // Still a 204 with nothing registered, or with the relay unreachable.
  relayDown = true;
  assert.equal((await call('DELETE', '/api/mobile/push', token)).status, 204);
});

test('signing out unregisters the device at the relay, without waiting for it', async () => {
  const { token } = await person();
  const relay = await relayToken('fe'.repeat(32));
  await register(token, { relayToken: relay, environment: 'production' });
  assert.equal((await call('DELETE', '/api/mobile/token', token)).status, 204);
  await eventually(async () => (await findRelayRegistration(relay)) === null);
});

test('PUT /push/servers/:guildId mutes and unmutes a server the person may see', async () => {
  const { token } = await person();
  const put = (key, body) => call('PUT', `/api/mobile/push/servers/${key}`, token, body);
  let res = await put(D_GUILD, { muted: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { mutedServers: [D_GUILD] });
  assert.deepEqual((await (await call('GET', '/api/mobile/push', token)).json()).mutedServers, [D_GUILD]);
  res = await put(D_GUILD, { muted: false });
  assert.deepEqual(await res.json(), { mutedServers: [] });
  assert.equal((await put(D_GUILD, { muted: 'yes' })).status, 400);
});

test('PUT: 403 for a server whose tickets the person may not see', async () => {
  const { id, token } = await person({ manage: false });
  const put = (key) =>
    call('PUT', `/api/mobile/push/servers/${encodeURIComponent(key)}`, token, { muted: true });
  // In the sign-in snapshot, but no live right in the server.
  assert.equal((await put(D_GUILD)).status, 403);
  // Not a server key at all, or a Fluxer server they have no rights in.
  assert.equal((await put('nope')).status, 403);
  assert.equal((await put(`fluxer:${F_GUILD}`)).status, 403);

  // A tickets staff role is enough.
  const STAFF = '700000000000000777';
  await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [STAFF] } });
  const realFetch = guild.members.fetch;
  guild.members.fetch = async (uid) => {
    if (uid !== id) throw new Error('Unknown Member');
    return { id, roles: { cache: { some: (fn) => [{ id: STAFF }].some(fn) } } };
  };
  try {
    const res = await put(D_GUILD);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mutedServers: [D_GUILD] });
  } finally {
    guild.members.fetch = realFetch;
    await setGuildModule(D_GUILD, 'tickets', { enabled: false, config: {} });
  }
});

test('GET /api/mobile/info: "push" when the instance can push, and the relay the app registers at', async () => {
  const info = async () => (await browser().get('/api/mobile/info')).json();
  let body = await info();
  assert.ok(body.features.includes('push'), 'relay mode');
  assert.equal(body.pushRelay, RELAY);

  configurePush({ apns: fakeApns, relayUrl: RELAY });
  body = await info();
  assert.ok(body.features.includes('push'), 'direct mode');
  assert.equal(Object.hasOwn(body, 'pushRelay'), false, 'direct mode: the app gives its device token here');

  configurePush({ apns: null, relayUrl: null });
  body = await info();
  assert.ok(!body.features.includes('push'));
  assert.ok(body.features.includes('app-login'));
  assert.equal(Object.hasOwn(body, 'pushRelay'), false);
});
