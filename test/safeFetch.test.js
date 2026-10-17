// Server-side fetches of URLs that server admins type in (RSS feeds, the welcome card
// background) must not reach the host's own network: loopback, private and link-local
// addresses (169.254.169.254 is the cloud metadata service) are refused, also after a redirect,
// and a response may not be bigger than the caller allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isPrivateAddress, safeFetch, SafeFetchError } from '../src/lib/safeFetch.js';

test('isPrivateAddress: internal ranges are private, public ones are not', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

/** A local server: private by definition, so only reachable with allowPrivate. */
async function local(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  test.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('safeFetch refuses a loopback address', async () => {
  const base = await local((req, res) => res.end('secret'));
  await assert.rejects(safeFetch(`${base}/`), SafeFetchError);
});

test('safeFetch refuses a name that resolves to loopback', async () => {
  const base = await local((req, res) => res.end('secret'));
  const port = new URL(base).port;
  await assert.rejects(safeFetch(`http://localhost:${port}/`), SafeFetchError);
});

test('safeFetch refuses other schemes', async () => {
  await assert.rejects(safeFetch('file:///etc/passwd'), SafeFetchError);
  await assert.rejects(safeFetch('ftp://example.com/x'), SafeFetchError);
});

test('safeFetch caps the body size', async () => {
  const base = await local((req, res) => res.end('x'.repeat(5000)));
  await assert.rejects(safeFetch(`${base}/`, { maxBytes: 1000, allowPrivate: true }), /too large/);
  const ok = await safeFetch(`${base}/`, { maxBytes: 10_000, allowPrivate: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 5000);
});

test('safeFetch follows a few redirects and stops after the limit', async () => {
  const base = await local((req, res) => {
    const n = Number(req.url.slice(1)) || 0;
    if (n < 10) {
      res.writeHead(302, { location: `/${n + 1}` });
      return res.end();
    }
    res.end('done');
  });
  await assert.rejects(safeFetch(`${base}/0`, { allowPrivate: true }), /redirects/);
  const ok = await safeFetch(`${base}/7`, { allowPrivate: true });
  assert.equal(ok.body.toString(), 'done');
});
