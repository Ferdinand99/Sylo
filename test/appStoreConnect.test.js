import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  AppStoreConnectError,
  createAppStoreConnect,
  normalisePrivateKey,
  signJwt,
} from '../src/lib/appStoreConnect.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64url = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('normalisePrivateKey accepts a PEM, a PEM with literal \\n, or base64 of a PEM', () => {
  assert.equal(normalisePrivateKey(PEM).trim(), PEM.trim());
  assert.equal(normalisePrivateKey(PEM.trim().replaceAll('\n', '\\n')).trim(), PEM.trim());
  assert.equal(normalisePrivateKey(Buffer.from(PEM).toString('base64')).trim(), PEM.trim());
  assert.equal(normalisePrivateKey(''), null);
  assert.equal(normalisePrivateKey('not a key'), null);
  assert.equal(normalisePrivateKey(null), null);
});

test('signJwt: ES256 header, team-key claims, signature the public key verifies', () => {
  const jwt = signJwt({ keyId: 'KEY123', issuerId: 'issuer-uuid', privateKey: PEM, iat: 1_000_000 });
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(b64url(h), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  const claims = b64url(p);
  assert.equal(claims.iss, 'issuer-uuid');
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.iat, 1_000_000);
  assert.ok(claims.exp - claims.iat <= 20 * 60, 'Apple rejects a lifetime over 20 minutes');
  assert.equal(claims.sub, undefined);
  const ok = createVerify('SHA256')
    .update(`${h}.${p}`)
    .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert.equal(ok, true);
});

test('signJwt: an individual key (no issuer id) uses sub "user" and no iss', () => {
  const claims = b64url(signJwt({ keyId: 'K', issuerId: null, privateKey: PEM, iat: 5 }).split('.')[1]);
  assert.equal(claims.sub, 'user');
  assert.equal(claims.iss, undefined);
});

function fakeApi(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const next = responses.shift();
    return new Response(next.body === undefined ? '{}' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

const make = (responses, extra = {}) => {
  const api = fakeApi(responses);
  let t = 1_000_000_000;
  const client = createAppStoreConnect({
    keyId: 'K',
    issuerId: 'I',
    privateKey: PEM,
    fetchImpl: api.fetchImpl,
    now: () => t,
    sleep: async () => {},
    ...extra,
  });
  return { client, calls: api.calls, advance: (ms) => (t += ms) };
};

test('get: sends a bearer token and the query string, and reuses the token for 15 minutes', async () => {
  const { client, calls, advance } = make([{ body: { data: [1] } }, { body: { data: [2] } }, { body: {} }]);
  const r = await client.get('/v1/apps', { limit: 10, 'filter[platform]': 'IOS' });
  assert.deepEqual(r, { data: [1] });
  assert.equal(
    calls[0].url,
    'https://api.appstoreconnect.apple.com/v1/apps?limit=10&filter%5Bplatform%5D=IOS'
  );
  assert.match(calls[0].headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await client.get('/v1/apps');
  assert.equal(calls[1].headers.Authorization, calls[0].headers.Authorization, 'token reused');
  advance(16 * 60 * 1000);
  await client.get('/v1/apps');
  assert.notEqual(
    calls[2].headers.Authorization,
    calls[0].headers.Authorization,
    'a fresh token after 15 min'
  );
});

test('getAll follows links.next and concatenates data (and included)', async () => {
  const { client, calls } = make([
    {
      body: {
        data: [{ id: 'a' }],
        included: [{ id: 'x' }],
        links: { next: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=2' },
      },
    },
    { body: { data: [{ id: 'b' }], links: {} } },
  ]);
  const all = await client.getAll('/v1/apps');
  assert.deepEqual(
    all.data.map((d) => d.id),
    ['a', 'b']
  );
  assert.deepEqual(
    all.included.map((d) => d.id),
    ['x']
  );
  assert.equal(calls[1].url, 'https://api.appstoreconnect.apple.com/v1/apps?cursor=2');
});

test('getAll stops at maxPages', async () => {
  const next = { links: { next: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=n' } };
  const { client, calls } = make([
    { body: { data: [1], ...next } },
    { body: { data: [2], ...next } },
    { body: { data: [3], ...next } },
  ]);
  const all = await client.getAll('/v1/apps', {}, { maxPages: 2 });
  assert.deepEqual(all.data, [1, 2]);
  assert.equal(calls.length, 2);
});

test('a 429 is retried once, honouring Retry-After', async () => {
  const slept = [];
  const { client, calls } = make(
    [{ status: 429, headers: { 'retry-after': '7' }, body: {} }, { body: { data: [] } }],
    {
      sleep: async (ms) => slept.push(ms),
    }
  );
  assert.deepEqual(await client.get('/v1/apps'), { data: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [7000]);
});

test('an API error carries the status and Apple detail, never the token', async () => {
  const { client } = make([
    {
      status: 403,
      body: {
        errors: [
          {
            status: '403',
            code: 'FORBIDDEN_ERROR',
            detail: 'This request is forbidden for security reasons.',
          },
        ],
      },
    },
  ]);
  await assert.rejects(client.get('/v1/apps'), (err) => {
    assert.ok(err instanceof AppStoreConnectError);
    assert.equal(err.status, 403);
    assert.match(err.message, /forbidden for security reasons/);
    assert.doesNotMatch(err.message, /Bearer|eyJ/);
    return true;
  });
});

test('getAll: a next link to another host is refused, so the token never leaves Apple', async () => {
  const { client, calls } = make([
    { body: { data: [1], links: { next: 'https://evil.example/v1/apps?cursor=x' } } },
    { body: { data: [2] } },
  ]);
  await assert.rejects(() => client.getAll('/v1/apps'), AppStoreConnectError);
  assert.equal(calls.length, 1, 'no request went to the other host');
  assert.ok(calls.every((c) => c.url.startsWith('https://api.appstoreconnect.apple.com/')));
});

test('a timeout or network error is retried once, then reported', async () => {
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1)
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return new Response(JSON.stringify({ data: [7] }), { status: 200 });
  };
  const { client } = make([], { fetchImpl: flaky });
  assert.deepEqual(await client.get('/v1/apps'), { data: [7] });
  assert.equal(n, 2);

  let calls = 0;
  const down = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const { client: broken } = make([], { fetchImpl: down });
  await assert.rejects(() => broken.get('/v1/apps'), /fetch failed/);
  assert.equal(calls, 2, 'one retry, not a loop');
});

test("an Apple server error (5xx) is retried once, since it is usually Apple's own hiccup", async () => {
  const slept = [];
  const { client, calls } = make([{ status: 500, body: {} }, { body: { data: [1] } }], {
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(await client.get('/v1/apps'), { data: [1] });
  assert.equal(calls.length, 2);
  assert.equal(slept.length, 1);
});

test('a second Apple server error is reported with its status', async () => {
  const { client } = make(
    [
      { status: 503, body: {} },
      { status: 500, body: {} },
    ],
    { sleep: async () => {} }
  );
  await assert.rejects(client.get('/v1/apps'), (err) => err.status === 500);
});
