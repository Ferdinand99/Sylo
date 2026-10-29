// X-Forwarded-For is only believed from a proxy on this machine or the local network. When the
// port is reachable directly from the internet, a client could otherwise send its own
// X-Forwarded-For and pick a new address for every request, past every per-client limit.
import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProxyTrustWarning, trustProxySetting } from '../src/web/server.js';

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

test('a peer on a Docker bridge address is trusted by default, an explicit TRUST_PROXY narrows it', () => {
  // The risk the startup warning is about: the gateway a published Docker port arrives from.
  const byDefault = trustProxySetting({ dashboardUrl: 'https://sylo.example.com', trustProxy: null });
  assert.equal(byDefault('172.17.0.1', 0), true, 'any private peer may set X-Forwarded-For');
  // An explicit proxy address is a string Express matches against the peer only.
  assert.equal(trustProxySetting({ dashboardUrl: 'https://x', trustProxy: '172.18.0.5' }), '172.18.0.5');
});

test('the default proxy trust warns for a public https DASHBOARD_URL, and only then', () => {
  const warn = (dashboardUrl, trustProxy = null) => defaultProxyTrustWarning({ dashboardUrl, trustProxy });
  assert.match(warn('https://sylo.example.com'), /TRUST_PROXY is not set/);
  assert.ok(warn('https://sylo.example.com').includes('docs/self-hosting.md'));
  assert.equal(warn('https://sylo.example.com', '172.18.0.5'), null, 'set explicitly');
  assert.equal(warn('https://sylo.example.com', 'false'), null, 'set explicitly');
  assert.equal(warn(null), null, 'no DASHBOARD_URL: nothing is trusted');
  assert.equal(warn('http://sylo.example.com'), null, 'not https');
  assert.equal(warn('https://localhost:3000'), null, 'not public');
  assert.equal(warn('https://192.168.1.5'), null, 'not public');
});
