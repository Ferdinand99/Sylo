// The Postal Pigeon client (src/lib/pigeon.js): registering with a proof of work, keeping the
// credential, sending one alert to one handle, and what each answer means. Pigeon is faked at
// the fetch level, so nothing here touches the network.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPigeonClient, PUSH_TTL_SECONDS } from '../src/lib/pigeon.js';
import { leadingZeroBits, solvePow, solvePowInWorker } from '../src/lib/pigeonPow.js';

const URL_A = 'https://pigeon.example';
const URL_B = 'https://other-pigeon.example';
const HANDLE = `hrh_${'h'.repeat(40)}`;
const CREDENTIAL = `hrk_${'c'.repeat(40)}`;
const SECRET = 'a-session-secret';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function memoryStore() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => void map.set(key, value),
  };
}

/**
 * A client against a fake Pigeon. `routes` maps "METHOD /path" to a function of the request (its
 * parsed body and headers) returning a Response, or to a list of them used in turn.
 */
function setup({ routes = {}, store = memoryStore(), url = URL_A, secret = SECRET, version = '5.0.0' } = {}) {
  const calls = [];
  const queues = new Map();
  let clock = 1_000_000;
  const fetchImpl = async (target, init = {}) => {
    const path = target.replace(/^https?:\/\/[^/]+/, '');
    const key = `${init.method} ${path}`;
    const call = {
      key,
      origin: new URL(target).origin,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
      init,
    };
    calls.push(call);
    let handler = routes[key];
    if (Array.isArray(handler)) {
      const queue = queues.get(key) ?? [...handler];
      queues.set(key, queue);
      handler = queue.length > 1 ? queue.shift() : queue[0];
    }
    if (!handler) return json(404, { error: 'not_found' });
    return handler(call);
  };
  const client = createPigeonClient({
    url: () => url,
    store,
    secret,
    version,
    fetchImpl,
    now: () => clock,
    solve: async (challenge, difficulty) => solvePow(challenge, difficulty),
  });
  return {
    client,
    calls,
    store,
    advance: (ms) => void (clock += ms),
    count: (key) => calls.filter((c) => c.key === key).length,
  };
}

const challengeRoute =
  (difficulty = 4) =>
  () =>
    json(200, { challenge: 'c'.repeat(32), difficulty, expires_at: 'x' });
const registerRoute =
  (credential = CREDENTIAL) =>
  () =>
    json(201, { instance_credential: credential });
const accepted = () => json(200, { results: [{ status: 'accepted' }] });
const REGISTRATION = {
  'GET /v1/challenge': challengeRoute(),
  'POST /v1/instances': registerRoute(),
};

// --- the proof of work -------------------------------------------------------------------------

test('leadingZeroBits counts bits across bytes', () => {
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x10])), 19);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00])), 16);
});

test('solvePow finds the first nonce whose SHA-256 over challenge and nonce has enough zero bits', () => {
  const challenge = 'pigeon-challenge-1';
  for (const difficulty of [1, 8, 12, 16]) {
    const nonce = solvePow(challenge, difficulty);
    const bits = (n) =>
      leadingZeroBits(
        createHash('sha256')
          .update(challenge + n)
          .digest()
      );
    assert.ok(bits(nonce) >= difficulty, `difficulty ${difficulty}`);
    // The first one counting up from 0.
    for (let n = 0; n < Number(nonce); n += 1) assert.ok(bits(String(n)) < difficulty);
  }
  assert.equal(solvePow(challenge, 0), '0');
});

test('the worker thread solves it, and is stopped when it takes too long', async () => {
  const nonce = await solvePowInWorker('worker-challenge', 10, 20_000);
  assert.ok(leadingZeroBits(createHash('sha256').update(`worker-challenge${nonce}`).digest()) >= 10);
  await assert.rejects(() => solvePowInWorker('worker-challenge', 60, 150), /pow_timeout/);
});

// --- registering -------------------------------------------------------------------------------

test('the first send registers (product sylo, the proof of work, the version) and keeps the credential sealed', async () => {
  const t = setup({ routes: { ...REGISTRATION, 'POST /v1/push': accepted } });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'r'.repeat(22), collapse: 'abc' }), {
    status: 'accepted',
  });

  const registration = t.calls.find((c) => c.key === 'POST /v1/instances');
  assert.equal(registration.body.product, 'sylo');
  assert.equal(registration.body.version, '5.0.0');
  assert.equal(registration.body.challenge, 'c'.repeat(32));
  const bits = leadingZeroBits(
    createHash('sha256')
      .update(registration.body.challenge + registration.body.nonce)
      .digest()
  );
  assert.ok(bits >= 4, 'the nonce meets the difficulty Pigeon asked for');
  for (const c of t.calls.filter((c) => c.key !== 'POST /v1/push')) {
    assert.equal(c.headers.authorization, undefined, 'registration is not authenticated');
  }

  assert.equal(t.store.map.get('pigeon_url'), URL_A);
  const sealed = t.store.map.get('pigeon_credential');
  assert.ok(sealed && !sealed.includes('hrk_') && !sealed.includes(CREDENTIAL), 'not stored in the clear');
  const push = t.calls.find((c) => c.key === 'POST /v1/push');
  assert.equal(push.headers.authorization, `Bearer ${CREDENTIAL}`);
});

test('the credential is used again, also by a new client with the same store and secret', async () => {
  const store = memoryStore();
  const routes = { ...REGISTRATION, 'POST /v1/push': accepted };
  const first = setup({ routes, store });
  await first.client.send(HANDLE, { ref: 'a' });
  const second = setup({ routes, store });
  await second.client.send(HANDLE, { ref: 'b' });
  assert.equal(first.count('POST /v1/instances'), 1);
  assert.equal(second.count('POST /v1/instances'), 0, 'no second registration');
  assert.equal(second.calls.at(-1).headers.authorization, `Bearer ${CREDENTIAL}`);
});

test('a credential is never sent to a relay it was not issued by', async () => {
  const store = memoryStore();
  const routes = { ...REGISTRATION, 'POST /v1/push': accepted };
  await setup({ routes, store, url: URL_A }).client.send(HANDLE, { ref: 'a' });
  const other = setup({ routes, store, url: URL_B });
  await other.client.send(HANDLE, { ref: 'b' });
  assert.equal(other.count('POST /v1/instances'), 1, 'registers at the other relay instead');
  assert.ok(other.calls.every((c) => c.origin === URL_B));
  assert.equal(store.map.get('pigeon_url'), URL_B);
});

test('a credential sealed with another secret cannot be opened: it registers again', async () => {
  const store = memoryStore();
  const routes = { ...REGISTRATION, 'POST /v1/push': accepted };
  await setup({ routes, store, secret: 'old-secret' }).client.send(HANDLE, { ref: 'a' });
  const t = setup({ routes, store, secret: 'new-secret' });
  assert.equal((await t.client.send(HANDLE, { ref: 'b' })).status, 'accepted');
  assert.equal(t.count('POST /v1/instances'), 1);
});

test('two sends at once register once', async () => {
  const t = setup({ routes: { ...REGISTRATION, 'POST /v1/push': accepted } });
  const results = await Promise.all([
    t.client.send(HANDLE, { ref: 'a' }),
    t.client.send(HANDLE, { ref: 'b' }),
    t.client.send(HANDLE, { ref: 'c' }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['accepted', 'accepted', 'accepted']
  );
  assert.equal(t.count('POST /v1/instances'), 1);
});

test('a failed registration waits a minute before the next one', async () => {
  const t = setup({
    routes: {
      'GET /v1/challenge': [() => json(503, { error: 'overloaded' }), challengeRoute()],
      'POST /v1/instances': registerRoute(),
      'POST /v1/push': accepted,
    },
  });
  const first = await t.client.send(HANDLE, { ref: 'a' });
  assert.equal(first.status, 'unavailable');
  assert.equal(first.reason, 'overloaded');
  assert.equal(t.count('GET /v1/challenge'), 1);

  t.advance(30_000);
  const early = await t.client.send(HANDLE, { ref: 'b' });
  assert.deepEqual([early.status, early.reason], ['unavailable', 'registration_backoff']);
  assert.equal(t.count('GET /v1/challenge'), 1, 'no request during the pause');

  t.advance(31_000);
  assert.equal((await t.client.send(HANDLE, { ref: 'c' })).status, 'accepted');
});

test('a refusal is not tried again every minute, only after ten', async () => {
  const t = setup({
    routes: {
      'GET /v1/challenge': challengeRoute(),
      'POST /v1/instances': [() => json(400, { error: 'invalid_request' }), registerRoute()],
      'POST /v1/push': accepted,
    },
  });
  assert.equal((await t.client.send(HANDLE, { ref: 'a' })).reason, 'invalid_request');
  t.advance(5 * 60_000);
  assert.equal((await t.client.send(HANDLE, { ref: 'b' })).reason, 'registration_backoff');
  assert.equal(t.count('GET /v1/challenge'), 1);
  t.advance(5 * 60_000 + 1000);
  assert.equal((await t.client.send(HANDLE, { ref: 'c' })).status, 'accepted');
});

test('a challenge that asks for too much work is refused', async () => {
  const t = setup({
    routes: { 'GET /v1/challenge': challengeRoute(33), 'POST /v1/instances': registerRoute() },
  });
  const r = await t.client.send(HANDLE, { ref: 'a' });
  assert.deepEqual([r.status, r.reason], ['unavailable', 'challenge_out_of_range']);
  assert.equal(t.count('POST /v1/instances'), 0);
});

test('a proof of work that fails or times out is unavailable, not an exception', async () => {
  const client = createPigeonClient({
    url: () => URL_A,
    store: memoryStore(),
    secret: SECRET,
    fetchImpl: async () => json(200, { challenge: 'x'.repeat(20), difficulty: 20 }),
    solve: async () => {
      throw new Error('pow_timeout');
    },
  });
  const r = await client.send(HANDLE, { ref: 'a' });
  assert.deepEqual([r.status, r.reason], ['unavailable', 'pow_timeout']);
});

test('ensureRegistered registers without sending anything', async () => {
  const t = setup({ routes: REGISTRATION });
  assert.equal(await t.client.ensureRegistered(), true);
  assert.equal(t.count('POST /v1/instances'), 1);
  assert.equal(t.count('POST /v1/push'), 0);
  assert.equal(await t.client.ensureRegistered(), true);
  assert.equal(t.count('POST /v1/instances'), 1, 'already registered');
});

// --- sending -----------------------------------------------------------------------------------

test('the push has the handle, a reference and a collapse key, and nothing else of the notification', async () => {
  const t = setup({ routes: { ...REGISTRATION, 'POST /v1/push': accepted } });
  await t.client.send(HANDLE, { ref: 'R'.repeat(22), collapse: 'K'.repeat(32) });
  const { body } = t.calls.find((c) => c.key === 'POST /v1/push');
  assert.deepEqual(Object.keys(body).sort(), ['collapse', 'event_id', 'handles', 'kind', 'ref', 'ttl']);
  assert.match(body.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(body.handles, [HANDLE]);
  assert.equal(body.kind, 'alert');
  assert.equal(body.ref, 'R'.repeat(22));
  assert.equal(body.collapse, 'K'.repeat(32));
  assert.equal(body.ttl, PUSH_TTL_SECONDS);
  assert.equal(PUSH_TTL_SECONDS, 3600);
});

test('every send has a new event id, and redirects are not followed', async () => {
  const t = setup({ routes: { ...REGISTRATION, 'POST /v1/push': accepted } });
  await t.client.send(HANDLE, { ref: 'a' });
  await t.client.send(HANDLE, { ref: 'b' });
  const pushes = t.calls.filter((c) => c.key === 'POST /v1/push');
  assert.notEqual(pushes[0].body.event_id, pushes[1].body.event_id);
  assert.ok(t.calls.every((c) => c.init.redirect === 'manual'));
});

test('what Pigeon says about the handle is passed on', async () => {
  const answers = [
    { status: 'accepted' },
    { status: 'duplicate' },
    { status: 'gone' },
    { status: 'limited', retry_after: 600 },
    { status: 'unsupported_kind' },
    { status: 'unavailable' },
    { status: 'something-new' },
    {},
  ];
  const queue = answers.map((a) => () => json(200, { results: [a] }));
  const t = setup({ routes: { ...REGISTRATION, 'POST /v1/push': queue } });
  const got = [];
  for (let i = 0; i < answers.length; i += 1) got.push(await t.client.send(HANDLE, { ref: `r${i}` }));
  assert.deepEqual(got, [
    { status: 'accepted' },
    { status: 'duplicate' },
    { status: 'gone' },
    { status: 'limited', retryAfter: 600 },
    { status: 'unsupported_kind' },
    { status: 'unavailable' },
    { status: 'unavailable' },
    { status: 'unavailable' },
  ]);
});

test('a relay that no longer knows the credential gets one new registration, and the push is retried once', async () => {
  const store = memoryStore();
  const t = setup({
    store,
    routes: {
      ...REGISTRATION,
      'POST /v1/instances': [registerRoute(`hrk_${'1'.repeat(40)}`), registerRoute(`hrk_${'2'.repeat(40)}`)],
      'POST /v1/push': [
        (call) =>
          call.headers.authorization.endsWith('1'.repeat(40))
            ? json(401, { error: 'unknown_instance' })
            : accepted(),
      ],
    },
  });
  assert.equal((await t.client.send(HANDLE, { ref: 'a' })).status, 'accepted');
  assert.equal(t.count('POST /v1/instances'), 2);
  assert.equal(t.count('POST /v1/push'), 2);
  assert.equal((await t.client.send(HANDLE, { ref: 'b' })).status, 'accepted');
  assert.equal(t.count('POST /v1/instances'), 2, 'the new credential is kept');
});

test('a relay that keeps saying unknown_instance is not asked in a loop', async () => {
  const t = setup({
    routes: { ...REGISTRATION, 'POST /v1/push': () => json(401, { error: 'unknown_instance' }) },
  });
  const r = await t.client.send(HANDLE, { ref: 'a' });
  assert.deepEqual([r.status, r.reason], ['unavailable', 'unknown_instance']);
  assert.equal(t.count('POST /v1/push'), 2);
  assert.equal(t.count('POST /v1/instances'), 2);
});

test('suspended: nothing is sent for an hour, then it tries again', async () => {
  let suspended = true;
  const t = setup({
    routes: {
      ...REGISTRATION,
      'POST /v1/push': () => (suspended ? json(403, { error: 'suspended' }) : accepted()),
    },
  });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'a' }), {
    status: 'unavailable',
    reason: 'suspended',
  });
  assert.equal(t.client.suspended(), true);
  const calls = t.calls.length;
  t.advance(59 * 60_000);
  assert.equal((await t.client.send(HANDLE, { ref: 'b' })).reason, 'suspended');
  assert.equal(t.calls.length, calls, 'no request while suspended');

  suspended = false;
  t.advance(2 * 60_000);
  assert.equal(t.client.suspended(), false);
  assert.equal((await t.client.send(HANDLE, { ref: 'c' })).status, 'accepted');
});

test('suspended at registration counts too', async () => {
  const t = setup({
    routes: { 'GET /v1/challenge': () => json(403, { error: 'suspended' }) },
  });
  assert.equal((await t.client.send(HANDLE, { ref: 'a' })).reason, 'suspended');
  const calls = t.calls.length;
  assert.equal((await t.client.send(HANDLE, { ref: 'b' })).reason, 'suspended');
  assert.equal(t.calls.length, calls);
});

test('server errors and rate limits are unavailable, with the wait Pigeon asked for', async () => {
  const t = setup({
    routes: {
      ...REGISTRATION,
      'POST /v1/push': [
        () => json(503, { error: 'overloaded' }, { 'retry-after': '30' }),
        () => json(500, {}),
        () => json(429, { error: 'rate_limited' }),
        () => json(400, { error: 'invalid_request' }),
      ],
    },
  });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'a' }), {
    status: 'unavailable',
    reason: 'overloaded',
    retryAfter: 30,
  });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'b' }), { status: 'unavailable', reason: 'http_500' });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'c' }), {
    status: 'unavailable',
    reason: 'rate_limited',
  });
  assert.deepEqual(await t.client.send(HANDLE, { ref: 'd' }), {
    status: 'unavailable',
    reason: 'invalid_request',
  });
});

test('a timeout, a refused connection, a redirect, an oversized or unreadable reply: unavailable', async () => {
  const cases = [
    [
      async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
      'timeout',
    ],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      'network_error',
    ],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'http_302'],
    [() => new Response('x'.repeat(70 * 1024), { status: 200 }), 'reply_too_large'],
    [() => new Response('<html>', { status: 200 }), 'unavailable'],
  ];
  for (const [respond, reason] of cases) {
    const client = createPigeonClient({
      url: () => URL_A,
      store: memoryStore(),
      secret: SECRET,
      fetchImpl: async (target, init) => {
        if (target.endsWith('/v1/challenge')) return json(200, { challenge: 'c'.repeat(20), difficulty: 1 });
        if (target.endsWith('/v1/instances')) return json(201, { instance_credential: CREDENTIAL });
        return respond(target, init);
      },
      solve: async (c, d) => solvePow(c, d),
    });
    const r = await client.send(HANDLE, { ref: 'a' });
    assert.equal(r.status, 'unavailable', reason);
    if (reason !== 'unavailable') assert.equal(r.reason, reason);
  }
});

test('without an address nothing is sent; with a bad one in the reply nothing leaks', async () => {
  const none = setup({ url: null, routes: REGISTRATION });
  assert.deepEqual(await none.client.send(HANDLE, { ref: 'a' }), {
    status: 'unavailable',
    reason: 'not_configured',
  });
  assert.equal(none.calls.length, 0);
  assert.equal(await none.client.ensureRegistered(), false);

  const t = setup({
    routes: { ...REGISTRATION, 'POST /v1/push': () => json(400, { error: `bad ${HANDLE}` }) },
  });
  const r = await t.client.send(HANDLE, { ref: 'a' });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(HANDLE) && !text.includes(CREDENTIAL), 'no handle or credential in the answer');
});
