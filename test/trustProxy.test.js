// X-Forwarded-For is only believed from a proxy on this machine or the local network. When the
// port is reachable directly from the internet, a client could otherwise send its own
// X-Forwarded-For and pick a new address for every request, past every per-client limit.
import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { trustProxySetting } from '../src/web/server.js';

test('without DASHBOARD_URL nothing is trusted', () => {
  assert.equal(trustProxySetting({ dashboardUrl: null, trustProxy: null }), false);
});

test('behind DASHBOARD_URL, one private or loopback hop is trusted', () => {
  const trust = trustProxySetting({ dashboardUrl: 'https://sylo.example.com', trustProxy: null });
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('172.17.0.2', 0), true);
  assert.equal(trust('8.8.4.4', 0), false, 'a public peer is the client itself');
  assert.equal(trust('10.0.0.1', 1), false, 'only one hop');
});

test('TRUST_PROXY overrides it', () => {
  assert.equal(trustProxySetting({ dashboardUrl: 'https://x', trustProxy: 'false' }), false);
  assert.equal(trustProxySetting({ dashboardUrl: null, trustProxy: '2' }), 2);
  assert.equal(trustProxySetting({ dashboardUrl: null, trustProxy: '10.0.0.0/8' }), '10.0.0.0/8');
});
