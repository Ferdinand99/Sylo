// Push through Postal Pigeon, the instance's side: /api/mobile/push takes the handle the app got
// from Pigeon, GET /api/mobile/push/events/:ref gives the app the text of a notification that
// carries none, and /api/mobile/info announces Pigeon. The older ways (a relay, direct) are in
// test/mobilePush.test.js; they run here only where they meet Pigeon.
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
const { createPushEvent, findPushEvent } = await import('../src/db/pushEvents.js');
const { findRelayRegistration } = await import('../src/db/pushRelay.js');
const { configurePush } = await import('../src/lib/push.js');
const { createPushRelayRouter } = await import('../src/web/routes/pushRelay.js');

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
async function person({ manage = true, withBrowser = false, operator = false } = {}) {
  setProfiles(operator ? { discordId: '111111111111111111' } : undefined);
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
  configurePush({ pigeonUrl: null, pigeon: undefined });
  relayMode();
  relayDown = false;
  apnsCalls.length = 0;
});
test.after(() => configurePush({ relayUrl: null, pigeonUrl: null, apns: undefined, deliver: null }));

// --- Postal Pigeon -------------------------------------------------------------------------

const PIGEON = 'https://pigeon.example.test';
const HANDLE = `hrh_${'a1'.repeat(20)}`;
const pigeonMode = (extra = {}) => configurePush({ pigeonUrl: PIGEON, ...extra });
const pigeonOnly = () => pigeonMode({ relayUrl: null, apns: null });
const HOUR = 60 * 60 * 1000;

test('POST, Pigeon: stores the handle the app got, and never calls Pigeon', async () => {
  pigeonMode();
  relayDown = true;
  const { token, tokenId } = await person();
  const res = await register(token, { pigeonHandle: HANDLE, environment: 'production' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const push = await apiTokenPush(tokenId);
  assert.equal(push.pigeonHandle, HANDLE);
  assert.equal(push.deviceToken, null);
  assert.equal(push.relayToken, null);
  assert.equal(push.environment, 'production');
  assert.equal(push.pigeonProvenAt, null);
  assert.deepEqual(await (await call('GET', '/api/mobile/push', token)).json(), {
    enabled: true,
    mutedServers: [],
  });
});

test('POST, Pigeon: a malformed handle or environment, or a handle with something else, is invalid_push_token', async () => {
  pigeonMode();
  const { token, tokenId } = await person();
  for (const body of [
    { pigeonHandle: 'hrh_short', environment: 'production' },
    { pigeonHandle: `hrm_${'a'.repeat(40)}`, environment: 'production' },
    { pigeonHandle: `hrh_${'a'.repeat(129)}`, environment: 'production' },
    { pigeonHandle: `hrh_${'a b'.repeat(10)}`, environment: 'production' },
    { pigeonHandle: 12345, environment: 'production' },
    { pigeonHandle: null, environment: 'production' },
    { pigeonHandle: HANDLE, environment: 'staging' },
    { pigeonHandle: HANDLE },
    { pigeonHandle: HANDLE, deviceToken: DEVICE, environment: 'production' },
    { pigeonHandle: HANDLE, relayToken: 'A'.repeat(43), environment: 'production' },
  ]) {
    const res = await register(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid_push_token' });
  }
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
});

test('POST, Pigeon not in use here: a handle is refused the way a wrong token is', async () => {
  const { token, tokenId } = await person();
  let res = await register(token, { pigeonHandle: HANDLE, environment: 'production' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'relay_token_required' }, 'relay mode');
  configurePush({ apns: fakeApns });
  res = await register(token, { pigeonHandle: HANDLE, environment: 'production' });
  assert.deepEqual(await res.json(), { error: 'device_token_required' }, 'direct mode');
  configurePush({ apns: null, relayUrl: null });
  res = await register(token, { pigeonHandle: HANDLE, environment: 'production' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'push_unavailable' });
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
});

test('POST, only Pigeon here: an older app that sends a token gets pigeon_handle_required', async () => {
  pigeonOnly();
  const { token, tokenId } = await person();
  for (const body of [DIRECT, { relayToken: 'A'.repeat(43), environment: 'production' }, {}]) {
    const res = await register(token, body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'pigeon_handle_required' });
  }
  assert.equal((await apiTokenPush(tokenId)).enabled, false);
  assert.equal((await register(token, { pigeonHandle: HANDLE, environment: 'development' })).status, 200);
  assert.equal((await apiTokenPush(tokenId)).environment, 'development');
});

test('POST, Pigeon and the older way side by side: an older app still registers as before', async () => {
  pigeonMode();
  const { token, tokenId } = await person();
  const relay = await relayToken();
  assert.equal((await register(token, { relayToken: relay, environment: 'production' })).status, 200);
  assert.equal((await apiTokenPush(tokenId)).relayToken, relay);

  // The same device, now with an app that knows Pigeon: the handle replaces the relay token, which
  // is unregistered at the relay.
  assert.equal((await register(token, { pigeonHandle: HANDLE, environment: 'production' })).status, 200);
  const push = await apiTokenPush(tokenId);
  assert.equal(push.pigeonHandle, HANDLE);
  assert.equal(push.relayToken, null);
  await eventually(async () => (await findRelayRegistration(relay)) === null);

  // And back, for a build that does not know it.
  assert.equal(
    (await register(token, { relayToken: await relayToken('cd'.repeat(32)), environment: 'production' }))
      .status,
    200
  );
  assert.equal((await apiTokenPush(tokenId)).pigeonHandle, null);
});

test('DELETE clears the handle and the notification content waiting for it', async () => {
  pigeonMode();
  const { token, tokenId } = await person();
  await register(token, { pigeonHandle: HANDLE, environment: 'production' });
  const ref = 'd'.repeat(22);
  await createPushEvent({ ref, tokenId, payload: ticketEvent(D_GUILD) });
  assert.equal((await call('DELETE', '/api/mobile/push', token)).status, 204);
  const push = await apiTokenPush(tokenId);
  assert.equal(push.enabled, false);
  assert.equal(push.pigeonHandle, null);
  assert.equal(await findPushEvent(ref, tokenId), null);
});

// --- GET /api/mobile/push/events/:ref ------------------------------------------------------

const ticketEvent = (guildId, text = 'ferdi: hello') => ({
  title: 'D-main',
  subtitle: 'New ticket',
  body: text,
  threadId: `${guildId}:5`,
  kind: 'ticket',
  data: { kind: 'ticket', guildId, ticketId: 5 },
});
const devLogEvent = () => ({
  title: 'Sylo dev log · sylo.example.com',
  subtitle: 'Error · db',
  body: 'connection lost',
  threadId: 'devlog',
  kind: 'devlog',
  data: { kind: 'devlog', level: 'error' },
});
const REF = (c) => c.repeat(22);
const getEvent = (token, ref) => call('GET', `/api/mobile/push/events/${ref}`, token);

test('events: the app gets the text behind its own reference, as plain data that is never cached', async () => {
  const { token, tokenId } = await person();
  await createPushEvent({ ref: REF('a'), tokenId, payload: ticketEvent(D_GUILD) });
  const res = await getEvent(token, REF('a'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.deepEqual(body, ticketEvent(D_GUILD));
  assert.ok(!JSON.stringify(body).includes('127.0.0.1'), 'no server address: the app knows it');
  assert.ok(!Object.hasOwn(body.data, 'server'));
});

test('events: unknown, expired and someone else’s references are the same 404', async () => {
  const mine = await person();
  const theirs = await person();
  await createPushEvent({ ref: REF('b'), tokenId: theirs.tokenId, payload: ticketEvent(D_GUILD) });
  await createPushEvent({
    ref: REF('c'),
    tokenId: mine.tokenId,
    payload: ticketEvent(D_GUILD),
    now: Date.now() - 3 * HOUR,
  });
  const unknown = await getEvent(mine.token, REF('z'));
  const foreign = await getEvent(mine.token, REF('b'));
  const expired = await getEvent(mine.token, REF('c'));
  for (const res of [unknown, foreign, expired]) {
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  const bodies = await Promise.all([unknown, foreign, expired].map((r) => r.text()));
  assert.equal(new Set(bodies).size, 1, 'nothing tells them apart');
  // The owner still gets theirs.
  assert.equal((await getEvent(theirs.token, REF('b'))).status, 200);
});

test('events: the reference is used up after two hours, not before', async () => {
  const { token, tokenId } = await person();
  await createPushEvent({
    ref: REF('e'),
    tokenId,
    payload: ticketEvent(D_GUILD),
    now: Date.now() - 2 * HOUR + 60_000,
  });
  assert.equal((await getEvent(token, REF('e'))).status, 200);
});

test('events: a reference of the wrong shape is a 404', async () => {
  const { token } = await person();
  for (const ref of [
    'short',
    'a'.repeat(21),
    'a'.repeat(23),
    `${'a'.repeat(21)}.`,
    `%2e${'a'.repeat(20)}`,
    'a'.repeat(300),
  ]) {
    const res = await getEvent(token, ref);
    assert.equal(res.status, 404, ref);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('events: only for app tokens: 401 signed out, 403 for a browser session', async () => {
  const { b, tokenId } = await person({ withBrowser: true });
  await createPushEvent({ ref: REF('f'), tokenId, payload: ticketEvent(D_GUILD) });
  const anon = await getEvent(null, REF('f'));
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('cache-control'), 'no-store');
  const cookie = await b.get(`/api/mobile/push/events/${REF('f')}`);
  assert.equal(cookie.status, 403);
  assert.match(cookie.headers.get('content-type'), /application\/json/);
  assert.equal(cookie.headers.get('cache-control'), 'no-store');
});

test('events: a ticket the account may no longer see is a 404', async () => {
  const { id, token, tokenId } = await person();
  await createPushEvent({ ref: REF('g'), tokenId, payload: ticketEvent(D_GUILD) });
  await createPushEvent({ ref: REF('h'), tokenId, payload: ticketEvent(`fluxer:${F_GUILD}`) });
  assert.equal((await getEvent(token, REF('g'))).status, 200);
  assert.equal((await getEvent(token, REF('h'))).status, 404, 'a server they never had rights in');

  guild.members.cache.delete(id); // the right is lost after the notification was sent
  const res = await getEvent(token, REF('g'));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!(await res.text()).includes('hello'), 'and the text is not in the answer');
});

test('events: a dev-log notification is for operators only', async () => {
  const op = await person({ operator: true });
  const plain = await person();
  await createPushEvent({ ref: REF('i'), tokenId: op.tokenId, payload: devLogEvent() });
  await createPushEvent({ ref: REF('j'), tokenId: plain.tokenId, payload: devLogEvent() });
  const ok = await getEvent(op.token, REF('i'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), devLogEvent());
  assert.equal((await getEvent(plain.token, REF('j'))).status, 404);
});

test('events: content of an unknown kind is never served', async () => {
  const { token, tokenId } = await person();
  await createPushEvent({
    ref: REF('k'),
    tokenId,
    payload: { ...ticketEvent(D_GUILD), data: { kind: 'other' }, kind: 'other' },
  });
  assert.equal((await getEvent(token, REF('k'))).status, 404);
});

test('events: signing out ends the references too', async () => {
  const { token, tokenId } = await person();
  await createPushEvent({ ref: REF('l'), tokenId, payload: ticketEvent(D_GUILD) });
  assert.equal((await call('DELETE', '/api/mobile/token', token)).status, 204);
  assert.equal(await findPushEvent(REF('l'), tokenId), null);
  assert.equal((await getEvent(token, REF('l'))).status, 401);
});

// --- /api/mobile/info in the three configurations -------------------------------------------

test('GET /api/mobile/info: the three ways to configure Pigeon', async () => {
  const info = async () => (await browser().get('/api/mobile/info')).json();

  // Without PIGEON_URL: as before.
  let body = await info();
  assert.ok(body.features.includes('push'));
  assert.ok(!body.features.includes('push-pigeon'));
  assert.equal(Object.hasOwn(body, 'pigeon'), false);

  // Pigeon and the older way: both announced; an older app ignores what it does not know.
  pigeonMode();
  body = await info();
  assert.ok(body.features.includes('push') && body.features.includes('push-pigeon'));
  assert.equal(body.pigeon, PIGEON);
  assert.equal(body.pushRelay, RELAY);

  pigeonMode({ apns: fakeApns });
  body = await info();
  assert.ok(body.features.includes('push') && body.features.includes('push-pigeon'));
  assert.equal(body.pigeon, PIGEON);
  assert.equal(Object.hasOwn(body, 'pushRelay'), false);

  // Only Pigeon: an older app is told there are no notifications ("push" is not announced).
  pigeonOnly();
  body = await info();
  assert.ok(!body.features.includes('push'));
  assert.ok(body.features.includes('push-pigeon'));
  assert.equal(body.pigeon, PIGEON);
  assert.equal(Object.hasOwn(body, 'pushRelay'), false);
  assert.ok(body.features.includes('app-login'));

  // Nothing at all.
  configurePush({ pigeonUrl: null });
  body = await info();
  assert.ok(!body.features.includes('push') && !body.features.includes('push-pigeon'));
  assert.equal(Object.hasOwn(body, 'pigeon'), false);
});
