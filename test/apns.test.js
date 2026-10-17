// The APNs client (src/lib/apns.js) against a fake HTTP/2 session: never Apple itself. Covers the
// provider token (ES256 JWT, cached), the request headers, the host per environment, session
// reuse and reconnects, and how Apple's answers map to ok / gone / error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createApnsClient, buildApnsPayload, APNS_HOSTS } from '../src/lib/apns.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const DEVICE = 'ab'.repeat(32);

/**
 * A fake `http2.connect`: records each session and request; `reply(headers, body)` decides the
 * answer per request (status, body) or throws to make the stream fail.
 */
function fakeTransport(reply = () => ({ status: 200, body: '' })) {
  const sessions = [];
  const requests = [];
  const connect = (origin) => {
    const session = new EventEmitter();
    session.origin = origin;
    session.closed = false;
    session.destroyed = false;
    session.unref = () => {};
    session.close = () => {
      session.closed = true;
      session.emit('close');
    };
    session.destroyed = false;
    session.destroy = () => {
      session.destroyed = true;
      session.emit('close');
    };
    session.request = (headers) => {
      const stream = new EventEmitter();
      stream.close = () => {};
      stream.end = (body) => {
        const record = { origin, headers, body: JSON.parse(body), session };
        requests.push(record);
        setImmediate(() => {
          let answer;
          try {
            answer = reply(record);
          } catch (err) {
            stream.emit('error', err);
            return;
          }
          if (answer === 'hang') return;
          stream.emit('response', { ':status': answer.status });
          if (answer.body) stream.emit('data', Buffer.from(answer.body));
          stream.emit('end');
        });
      };
      return stream;
    };
    sessions.push(session);
    return session;
  };
  return { connect, sessions, requests };
}

const client = (transport, extra = {}) =>
  createApnsClient({
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    privateKey: PEM,
    topic: 'net.opland.sylo',
    connect: transport.connect,
    ...extra,
  });

const payload = buildApnsPayload({
  title: 'My server',
  body: 'member: hello',
  threadId: '900000000000000001:7',
  data: { kind: 'ticket', server: 'https://sylo.example.com', guildId: '900000000000000001', ticketId: 7 },
});

test('buildApnsPayload: the alert, default sound, thread id and the sylo deep link', () => {
  assert.deepEqual(payload, {
    aps: {
      alert: { title: 'My server', body: 'member: hello' },
      sound: 'default',
      'thread-id': '900000000000000001:7',
    },
    sylo: { kind: 'ticket', server: 'https://sylo.example.com', guildId: '900000000000000001', ticketId: 7 },
  });
  const withSubtitle = buildApnsPayload({ ...payloadInput(), subtitle: 'New ticket' });
  assert.equal(withSubtitle.aps.alert.subtitle, 'New ticket');
});

function payloadInput() {
  return {
    title: 'T',
    body: 'b',
    threadId: '900000000000000001:1',
    data: { kind: 'ticket', server: 'https://x.example', guildId: '900000000000000001', ticketId: 1 },
  };
}

test('send: POST /3/device/<token> with the provider token, topic, push type and priority', async () => {
  const t = fakeTransport();
  const apns = client(t);
  assert.deepEqual(await apns.send({ deviceToken: DEVICE, environment: 'production', payload }), {
    status: 'ok',
  });
  const [req] = t.requests;
  assert.equal(req.origin, APNS_HOSTS.production);
  assert.equal(req.headers[':method'], 'POST');
  assert.equal(req.headers[':path'], `/3/device/${DEVICE}`);
  assert.equal(req.headers['apns-topic'], 'net.opland.sylo');
  assert.equal(req.headers['apns-push-type'], 'alert');
  assert.equal(req.headers['apns-priority'], '10');
  assert.equal(req.headers['apns-collapse-id'], undefined);
  assert.deepEqual(req.body, payload);

  const [scheme, jwt] = req.headers.authorization.split(' ');
  assert.equal(scheme, 'bearer');
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(Object.keys(claims).sort(), ['iat', 'iss']);
  assert.equal(claims.iss, 'TEAM123456');
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
  const ok = createVerify('SHA256')
    .update(`${h}.${c}`)
    .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert.ok(ok, 'signed with the key');
});

test('the environment picks the host: development is the sandbox', async () => {
  const t = fakeTransport();
  const apns = client(t);
  await apns.send({ deviceToken: DEVICE, environment: 'development', payload });
  assert.equal(t.requests[0].origin, 'https://api.sandbox.push.apple.com');
  assert.equal(APNS_HOSTS.production, 'https://api.push.apple.com');
});

test('one session per host is reused; a goaway or error makes the next send reconnect', async () => {
  const t = fakeTransport();
  const apns = client(t);
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.equal(t.sessions.length, 1);
  await apns.send({ deviceToken: DEVICE, environment: 'development', payload });
  assert.equal(t.sessions.length, 2, 'the sandbox has its own');

  t.sessions[0].emit('goaway');
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.equal(t.sessions.length, 3);

  t.sessions[2].emit('error', new Error('ECONNRESET'));
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.equal(t.sessions.length, 4);
  apns.close();
});

test('the provider token is cached for about 50 minutes, then signed again', async () => {
  let clock = 1_800_000_000_000;
  const t = fakeTransport();
  const apns = client(t, { now: () => clock });
  const auth = () => t.requests.at(-1).headers.authorization;
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  const first = auth();
  clock += 49 * 60 * 1000;
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.equal(auth(), first);
  clock += 2 * 60 * 1000;
  await apns.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.notEqual(auth(), first);
  const iat = JSON.parse(Buffer.from(auth().split(' ')[1].split('.')[1], 'base64url')).iat;
  assert.equal(iat, Math.floor(clock / 1000));
});

test('410 and the bad-token 400s are "gone"; other answers are errors', async () => {
  const answers = [
    [
      { status: 410, body: '{"reason":"Unregistered"}' },
      { status: 'gone', reason: 'Unregistered' },
    ],
    [
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 'gone', reason: 'BadDeviceToken' },
    ],
    [
      { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' },
      { status: 'gone', reason: 'DeviceTokenNotForTopic' },
    ],
    [
      { status: 400, body: '{"reason":"PayloadTooLarge"}' },
      { status: 'error', reason: 'PayloadTooLarge' },
    ],
    [
      { status: 429, body: '{"reason":"TooManyRequests"}' },
      { status: 'error', reason: 'TooManyRequests' },
    ],
    [
      { status: 500, body: 'not json' },
      { status: 'error', reason: 'HTTP 500' },
    ],
  ];
  for (const [answer, expected] of answers) {
    const apns = client(fakeTransport(() => answer));
    assert.deepEqual(await apns.send({ deviceToken: DEVICE, environment: 'production', payload }), expected);
  }
});

test('after a provider-token rejection, a fresh token is signed at most every 20 minutes', async () => {
  // Apple answers TooManyProviderTokenUpdates when a key's token changes more often than that.
  let clock = 1_800_000_000_000;
  let status = 403;
  const t = fakeTransport(() => ({ status, body: '{"reason":"InvalidProviderToken"}' }));
  const apns = client(t, { now: () => clock });
  const send = async () =>
    (await apns.send({ deviceToken: DEVICE, environment: 'production', payload })).status;
  const auth = (i) => t.requests[i].headers.authorization;
  assert.equal(await send(), 'error');
  clock += 60_000;
  assert.equal(await send(), 'error');
  assert.equal(auth(1), auth(0), 'the same token again within 20 minutes');
  clock += 19 * 60_000;
  status = 200;
  assert.equal(await send(), 'ok');
  assert.notEqual(auth(2), auth(0), 'signed again once 20 minutes have passed');
  clock += 60_000;
  assert.equal(await send(), 'ok');
  assert.equal(auth(3), auth(2), 'and kept while it works');
});

test('a stream error or a timeout is an error result, never a throw', async () => {
  const failing = client(
    fakeTransport(() => {
      throw new Error('stream reset');
    })
  );
  const res = await failing.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.equal(res.status, 'error');
  assert.match(res.reason, /stream reset/);

  const hanging = client(
    fakeTransport(() => 'hang'),
    { timeoutMs: 20 }
  );
  const late = await hanging.send({ deviceToken: DEVICE, environment: 'production', payload });
  assert.deepEqual(late, { status: 'error', reason: 'timeout' });

  const broken = client({
    connect: () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(
    (await broken.send({ deviceToken: DEVICE, environment: 'production', payload })).status,
    'error'
  );
});

test('a timeout destroys the session, and the next send connects again', async () => {
  let hang = true;
  const t = fakeTransport(() => (hang ? 'hang' : { status: 200 }));
  const apns = client(t, { timeoutMs: 20 });
  assert.equal(
    (await apns.send({ deviceToken: DEVICE, environment: 'production', payload })).reason,
    'timeout'
  );
  assert.equal(t.sessions[0].destroyed, true);
  hang = false;
  assert.equal((await apns.send({ deviceToken: DEVICE, environment: 'production', payload })).status, 'ok');
  assert.equal(t.sessions.length, 2);
});

test('a device token that is not hex never reaches Apple', async () => {
  const t = fakeTransport();
  const apns = client(t);
  const res = await apns.send({ deviceToken: '../../x', environment: 'production', payload });
  assert.equal(res.status, 'gone');
  assert.equal(t.requests.length, 0);
});
