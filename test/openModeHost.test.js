// Open mode has no login: anyone who reaches the dashboard can use it. A web page can still
// reach a dashboard on the visitor's own network through DNS rebinding (its own domain,
// re-pointed at 192.168.x), and then both Origin and Host are the attacker's name, so the CSRF
// origin check passes. Open mode therefore only answers on local names and addresses.
import { request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';

const { base, close } = await startWebApp();
test.after(close);

function getWithHost(host) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/commands', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('open mode refuses a public host name', async () => {
  assert.equal(await getWithHost('rebind.attacker.example'), 403);
});

test('open mode answers on local names and addresses', async () => {
  for (const host of [
    'localhost:3000',
    '127.0.0.1',
    '192.168.1.20:3000',
    'tower',
    'sylo.local',
    '[::1]:3000',
  ]) {
    assert.notEqual(await getWithHost(host), 403, host);
  }
});

// No page may be framed by another site (clickjacking); the browser is also told not to guess
// content types or send full URLs to other sites.
test('every page forbids framing', async () => {
  const res = await fetch(`${base}/commands`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

// Behind DASHBOARD_URL a private peer is a trusted proxy, and a rebound page's own requests
// come from the victim's (private) browser: req.hostname then follows X-Forwarded-Host, which
// the page's script can set. The check must read the Host header itself.
test('the open-mode check reads the Host header, not X-Forwarded-Host', async () => {
  const { refuseRemoteHostsInOpenMode } = await import('../src/web/server.js');
  let status = 200;
  const res = {
    status(c) {
      status = c;
      return this;
    },
    type() {
      return this;
    },
    send() {
      return this;
    },
  };
  const req = {
    hostname: 'localhost',
    get: (h) => (h === 'host' ? 'rebind.attacker.example:3000' : undefined),
  };
  let passed = false;
  refuseRemoteHostsInOpenMode(req, res, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(status, 403);
});
