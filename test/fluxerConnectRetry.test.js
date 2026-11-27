// A self-hosted Fluxer behind a dynamic IP: a connect to an address that went away drops the SDK's pooled
// connections and tries once more (a new connection looks the name up again). Other failures are left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RequestManager } from '@fluxerjs/rest';
import { Client } from '@fluxerjs/core';
import { connectErrorCode, installConnectRetry } from '../src/platform/fluxerConnectRetry.js';

const connectError = (code) =>
  new Error('fetch failed', {
    cause: Object.assign(new Error(`connect ${code} 192.0.2.1:443`), { code, syscall: 'connect' }),
  });

/** A stand-in for the SDK's RequestManager whose answers are scripted. */
function fakeManager(script) {
  class Fake {
    calls = 0;
    async request(method, route) {
      const next = script[this.calls++];
      if (next instanceof Error) throw next;
      return { method, route, ...next };
    }
  }
  return Fake;
}

test('connect failures are found in the cause chain; failures on an open connection are not', () => {
  for (const code of ['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']) {
    assert.equal(connectErrorCode(connectError(code)), code);
    assert.equal(connectErrorCode(new Error('Request failed', { cause: connectError(code) })), code);
  }
  assert.equal(
    connectErrorCode(new Error('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
    'UND_ERR_CONNECT_TIMEOUT'
  );
  // happy eyeballs reports every address it tried
  const all = new AggregateError([connectError('EHOSTUNREACH').cause], 'all failed');
  assert.equal(connectErrorCode(new Error('fetch failed', { cause: all })), 'EHOSTUNREACH');
  // A timeout on a socket that was already open may have reached Fluxer: not retried.
  assert.equal(connectErrorCode(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })), null);
  assert.equal(connectErrorCode(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), null);
  assert.equal(connectErrorCode(Object.assign(new Error('Missing Access'), { statusCode: 403 })), null);
  assert.equal(connectErrorCode(null), null);
  const loop = new Error('loop');
  loop.cause = loop;
  assert.equal(connectErrorCode(loop), null);
});

test('a failed connect drops the pool and tries once more', async () => {
  const Fake = fakeManager([connectError('EHOSTUNREACH'), { ok: true }]);
  let resets = 0;
  installConnectRetry(Fake, { resetPool: async () => (resets += 1) });
  installConnectRetry(Fake, { resetPool: async () => (resets += 100) }); // a second install changes nothing
  const m = new Fake();
  const res = await m.request('POST', '/channels/1/messages', {});
  assert.deepEqual(res, { method: 'POST', route: '/channels/1/messages', ok: true });
  assert.equal(m.calls, 2);
  assert.equal(resets, 1);
});

test('only once: a second failed connect is thrown, and other errors are not retried', async () => {
  const Twice = fakeManager([connectError('ECONNREFUSED'), connectError('ECONNREFUSED'), { ok: true }]);
  installConnectRetry(Twice, { resetPool: async () => {} });
  const t = new Twice();
  await assert.rejects(t.request('GET', '/gateway/bot'), /fetch failed/);
  assert.equal(t.calls, 2);

  const refused = Object.assign(new Error('Missing Permissions'), { statusCode: 403 });
  const Refused = fakeManager([refused, { ok: true }]);
  let resets = 0;
  installConnectRetry(Refused, { resetPool: async () => (resets += 1) });
  const r = new Refused();
  await assert.rejects(r.request('POST', '/guilds/1/roles'), /Missing Permissions/);
  assert.deepEqual([r.calls, resets], [1, 0]);
});

test('an aborted request is not sent again, and a pool that will not close does not stop the retry', async () => {
  const Aborted = fakeManager([connectError('ETIMEDOUT'), { ok: true }]);
  installConnectRetry(Aborted, { resetPool: async () => {} });
  const signal = AbortSignal.abort();
  const a = new Aborted();
  await assert.rejects(a.request('GET', '/x', { signal }));
  assert.equal(a.calls, 1);

  const Stuck = fakeManager([connectError('ENETUNREACH'), { ok: true }]);
  installConnectRetry(Stuck, {
    resetPool: () => {
      throw new Error('cannot close');
    },
  });
  assert.equal((await new Stuck().request('GET', '/x')).ok, true);
});

test('the real SDK: its error for a refused connect is recognised, and the request is tried twice', async () => {
  // A port that was just free: nothing listens there.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  class Manager extends RequestManager {}
  let resets = 0;
  installConnectRetry(Manager, { resetPool: async () => (resets += 1) });
  const m = new Manager({
    api: `http://127.0.0.1:${port}`,
    version: '1',
    authPrefix: 'Bot',
    timeout: 5000,
    retries: 0,
    userAgent: 'test',
    locale: 'en-US',
  });
  m.setToken('x');
  const err = await m.request('POST', '/channels/1/messages', { body: { content: 'hi' } }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(connectErrorCode(err), 'ECONNREFUSED');
  assert.equal(resets, 1, 'the pool was dropped once before the second try');
});

test("the patched RequestManager is the one the Fluxer client uses (no second copy of @fluxerjs/rest)", () => {
  const client = new Client({});
  assert.ok(client.rest.requestManager instanceof RequestManager);
});
