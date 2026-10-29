// The push relay the hosted Sylo serves for self-hosted instances (src/web/routes/pushRelay.js):
// register a device, send ticket-shaped notifications to it, unregister. No account; strict
// validation; per-registration and per-IP limits. Apple is a fake APNs client here.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPushRelayRouter } from '../src/web/routes/pushRelay.js';
import { buildApnsPayload } from '../src/lib/apns.js';
import { findRelayRegistration } from '../src/db/pushRelay.js';

const INSTANCE = 'https://sylo.example.com';
const GUILD = 'fluxer:900000000000000301';
let deviceSeq = 0;
const device = () => (++deviceSeq).toString(16).padStart(64, 'c');

// What Apple says next, and everything sent to it.
const apnsCalls = [];
let apnsAnswer = { status: 'ok' };
const apns = {
  send: async (msg) => {
    apnsCalls.push(msg);
    return apnsAnswer;
  },
};
let clock = Date.now();

const app = express();
app.use(express.json());
app.use(
  '/api/push-relay/v1',
  createPushRelayRouter({ apns, now: () => clock, limits: { register: 1000, send: 1000, unregister: 1000 } })
);
const limited = express();
limited.use(express.json());
limited.use(
  '/api/push-relay/v1',
  createPushRelayRouter({ apns, limits: { register: 3, send: 3, unregister: 3 } })
);

async function listen(a) {
  const server = await new Promise((resolve) => {
    const s = a.listen(0, () => resolve(s));
  });
  test.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/push-relay/v1`;
}
const base = await listen(app);
const limitedBase = await listen(limited);

const post = (path, body, root = base) =>
  fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function register(extra = {}) {
  const res = await post('/register', {
    deviceToken: device(),
    environment: 'production',
    instance: INSTANCE,
    ...extra,
  });
  assert.equal(res.status, 200);
  return (await res.json()).relayToken;
}

const notification = (overrides = {}) => ({
  title: 'My server',
  subtitle: 'New ticket',
  body: 'member: hello there',
  threadId: `${GUILD}:12`,
  data: { kind: 'ticket', server: INSTANCE, guildId: GUILD, ticketId: 12 },
  ...overrides,
});

test.beforeEach(() => {
  apnsCalls.length = 0;
  apnsAnswer = { status: 'ok' };
});

test('register: a relay token for a valid device, environment and instance', async () => {
  const deviceToken = device();
  const res = await post('/register', { deviceToken, environment: 'development', instance: INSTANCE });
  assert.equal(res.status, 200);
  const { relayToken, ...rest } = await res.json();
  assert.match(relayToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(rest, {});
  const reg = await findRelayRegistration(relayToken);
  assert.equal(reg.deviceToken, deviceToken);
  assert.equal(reg.environment, 'development');
  assert.equal(reg.instance, INSTANCE);
});

test('register: anything malformed is a 400 and registers nothing', async () => {
  const good = { deviceToken: device(), environment: 'production', instance: INSTANCE };
  for (const body of [
    {},
    { ...good, deviceToken: 'xyz' },
    { ...good, deviceToken: 'a'.repeat(63) },
    { ...good, deviceToken: 'a'.repeat(201) },
    { ...good, deviceToken: 123 },
    { ...good, environment: 'staging' },
    { ...good, instance: 'ftp://sylo.example.com' },
    { ...good, instance: 'https://sylo.example.com/' },
    { ...good, instance: 'https://user:pw@sylo.example.com' },
    { ...good, instance: 'https://sylo.example.com?x=1' },
    { ...good, instance: 'not a url' },
    { ...good, instance: 'https://Sylo.Example.com' },
    { ...good, instance: 'HTTPS://sylo.example.com' },
    { ...good, instance: 'https://sylo.example.com:443' },
    { ...good, instance: 'https://sylo.example.com#x' },
    { ...good, instance: 'https://sylo.example.com/sylo/' },
    { ...good, instance: `https://${'a'.repeat(300)}.com` },
    { ...good, extra: true },
    [good],
  ]) {
    const res = await post('/register', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid_request' });
  }
});

test('send: 204, and Apple gets the payload the relay built for the registered device', async () => {
  const deviceToken = device();
  const { relayToken } = await (
    await post('/register', { deviceToken, environment: 'development', instance: INSTANCE })
  ).json();
  const res = await post('/send', { relayToken, notification: notification() });
  assert.equal(res.status, 204);
  assert.equal(apnsCalls.length, 1);
  assert.deepEqual(apnsCalls[0], {
    deviceToken,
    environment: 'development',
    payload: buildApnsPayload(notification()),
  });
  const noSubtitle = notification();
  delete noSubtitle.subtitle;
  assert.equal((await post('/send', { relayToken, notification: noSubtitle })).status, 204);
  assert.equal(apnsCalls[1].payload.aps.alert.subtitle, undefined);
});

test('send: a notification that is not exactly ticket-shaped is a 400 and reaches no one', async () => {
  const relayToken = await register();
  const bad = [
    notification({ title: '' }),
    notification({ title: 'x'.repeat(101) }),
    notification({ title: 7 }),
    notification({ subtitle: 'x'.repeat(101) }),
    notification({ body: 'x'.repeat(181) }),
    notification({ body: 'line\nbreak' }),
    notification({ body: 'zero\u200bwidth' }),
    notification({ body: 'right-to-left \u202eoverride' }),
    notification({ title: 'line\u2028separator' }),
    notification({ subtitle: 'para\u2029separator' }),
    notification({ body: 'lone \ud800 surrogate' }),
    notification({ threadId: `${GUILD}:13` }),
    notification({ data: { kind: 'ticket', server: INSTANCE, guildId: GUILD, ticketId: 12, url: 'x' } }),
    notification({ data: { kind: 'dm', server: INSTANCE, guildId: GUILD, ticketId: 12 } }),
    notification({ data: { kind: 'ticket', server: 'javascript:alert(1)', guildId: GUILD, ticketId: 12 } }),
    notification({ data: { kind: 'ticket', guildId: GUILD, ticketId: 12 } }),
    notification({ data: { kind: 'ticket', server: INSTANCE, guildId: 'nope', ticketId: 12 } }),
    notification({ data: { kind: 'ticket', server: INSTANCE, guildId: GUILD, ticketId: '12' } }),
    notification({ data: { kind: 'ticket', server: INSTANCE, guildId: GUILD, ticketId: 0 } }),
    { ...notification(), sound: 'loud' },
    null,
  ];
  for (const n of bad) {
    const res = await post('/send', { relayToken, notification: n });
    assert.equal(res.status, 400, JSON.stringify(n));
  }
  assert.equal((await post('/send', { relayToken, notification: notification(), more: 1 })).status, 400);
  assert.equal((await post('/send', { relayToken: 'short', notification: notification() })).status, 400);
  assert.equal(apnsCalls.length, 0);
  // A 180-character body (counted in code points) is fine.
  const emoji = '😀'.repeat(180);
  assert.equal(
    (await post('/send', { relayToken, notification: notification({ body: emoji }) })).status,
    204
  );
});

test('send: an unknown or unregistered relay token is a 410', async () => {
  const unknown = 'A'.repeat(43);
  assert.equal((await post('/send', { relayToken: unknown, notification: notification() })).status, 410);
  const relayToken = await register();
  assert.equal((await post('/unregister', { relayToken })).status, 204);
  assert.equal((await post('/send', { relayToken, notification: notification() })).status, 410);
  assert.equal(apnsCalls.length, 0);
  // Unregistering twice, or something unknown, is still a 204.
  assert.equal((await post('/unregister', { relayToken })).status, 204);
  assert.equal((await post('/unregister', { relayToken: 5 })).status, 400);
});

test('send: when Apple says the device is gone, the registration goes and the instance gets 410', async () => {
  const relayToken = await register();
  apnsAnswer = { status: 'gone', reason: 'Unregistered' };
  assert.equal((await post('/send', { relayToken, notification: notification() })).status, 410);
  assert.equal(await findRelayRegistration(relayToken), null);
});

test('send: any other Apple failure is a 502 and keeps the registration', async () => {
  const relayToken = await register();
  apnsAnswer = { status: 'error', reason: 'InternalServerError' };
  const res = await post('/send', { relayToken, notification: notification() });
  assert.equal(res.status, 502);
  assert.ok(await findRelayRegistration(relayToken));
});

test("send: the deep link is always the registration's own instance", async () => {
  const relayToken = await register();
  const other = { kind: 'ticket', server: 'https://evil.example', guildId: GUILD, ticketId: 12 };
  assert.equal(
    (await post('/send', { relayToken, notification: notification({ data: other }) })).status,
    204
  );
  assert.equal(apnsCalls[0].payload.sylo.server, INSTANCE);
});

test('register: an instance with a path is fine', async () => {
  const res = await post('/register', {
    deviceToken: device(),
    environment: 'production',
    instance: 'https://example.com/sylo',
  });
  assert.equal(res.status, 200);
});

test('send: at most 60 per device token per rolling hour, across its registrations', async () => {
  const deviceToken = device();
  const tokens = [];
  for (const instance of ['https://a.example.com', 'https://b.example.com']) {
    const res = await post('/register', { deviceToken, environment: 'production', instance });
    tokens.push((await res.json()).relayToken);
  }
  for (let i = 0; i < 60; i += 1) {
    const res = await post('/send', { relayToken: tokens[i % 2], notification: notification() });
    assert.equal(res.status, 204);
  }
  assert.equal((await post('/send', { relayToken: tokens[0], notification: notification() })).status, 429);
  assert.equal((await post('/send', { relayToken: tokens[1], notification: notification() })).status, 429);
  clock += 61 * 60 * 1000;
  assert.equal((await post('/send', { relayToken: tokens[1], notification: notification() })).status, 204);
});

test('send: at most 60 per registration per rolling hour', async () => {
  const relayToken = await register();
  const other = await register();
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await post('/send', { relayToken, notification: notification() })).status, 204);
  }
  const res = await post('/send', { relayToken, notification: notification() });
  assert.equal(res.status, 429);
  assert.equal(apnsCalls.length, 60);
  assert.equal((await post('/send', { relayToken: other, notification: notification() })).status, 204);

  clock += 30 * 60 * 1000;
  assert.equal((await post('/send', { relayToken, notification: notification() })).status, 429);
  clock += 31 * 60 * 1000;
  assert.equal((await post('/send', { relayToken, notification: notification() })).status, 204);
});

test('every endpoint is rate limited per IP', async () => {
  for (const path of ['/register', '/send', '/unregister']) {
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await post(path, {}, limitedBase)).status);
    assert.deepEqual(codes, [400, 400, 400, 429], path);
  }
});

// /register needs no account (a self-hosted instance's app registers itself), so random device
// tokens could fill the table. New registrations across all clients are capped per hour.
test('the relay refuses new registrations past its hourly ceiling', async () => {
  const capped = express();
  capped.use(express.json());
  capped.use(
    '/api/push-relay/v1',
    createPushRelayRouter({ apns, limits: { register: 1000, newPerHour: 2 } })
  );
  const root = await listen(capped);
  const body = () => ({ deviceToken: device(), environment: 'production', instance: INSTANCE });
  assert.equal((await post('/register', body(), root)).status, 200);
  assert.equal((await post('/register', body(), root)).status, 200);
  assert.equal((await post('/register', body(), root)).status, 429);
});

// A few addresses at their own cap must not use up the shared hourly budget: every real sign-in
// from another address still gets through.
test('registration: one client has its own hourly cap, and a few clients cannot use up the shared budget', async () => {
  const capped = express();
  capped.set('trust proxy', true);
  capped.use(express.json());
  capped.use(
    '/api/push-relay/v1',
    createPushRelayRouter({
      apns,
      limits: { register: 1000, newPerHour: 25, perIpPerHour: 12, sharedPerIp: 5 },
    })
  );
  const root = await listen(capped);
  const from = (ip) =>
    fetch(`${root}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ deviceToken: device(), environment: 'production', instance: INSTANCE }),
    });

  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
    for (let i = 0; i < 12; i += 1) assert.equal((await from(ip)).status, 200, `${ip} #${i}`);
    const over = await from(ip);
    assert.equal(over.status, 429, `${ip} is refused past its own cap`);
    assert.ok(over.headers.get('retry-after'));
  }
  // Four clients at their cap used 4 x 5 of the shared 25: a fifth, new client is served.
  assert.equal((await from('198.51.100.5')).status, 200);
  assert.equal((await from('203.0.113.9')).status, 200);
});
