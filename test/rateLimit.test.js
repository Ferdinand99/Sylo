import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, rateLimit } from '../src/web/middleware/rateLimit.js';

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    type() {
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

test('rateLimit allows up to max, then 429s with Retry-After', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const req = { baseUrl: '/x', ip: '1.2.3.4' };

  let passed = 0;
  for (let i = 0; i < 3; i += 1) {
    const res = fakeRes();
    mw(req, res, () => {
      passed += 1;
    });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(passed, 3);

  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['retry-after']);
});

test('rateLimit buckets are per IP', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const resA = fakeRes();
  const resB = fakeRes();
  mw({ baseUrl: '/y', ip: 'a' }, resA, () => {});
  mw({ baseUrl: '/y', ip: 'b' }, resB, () => {});
  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);
});

const hit = (mw, req) => {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => {
    passed = true;
  });
  return passed;
};

// An app-level limiter has no mount path. It used to key on the request path instead, so a
// new random path got a new bucket: the limit could be dodged, and the bucket map grew
// without bound.
test('an app-level limiter counts every path from one client together', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2 });
  assert.equal(hit(mw, { baseUrl: '', path: '/a1', ip: '9.9.9.1' }), true);
  assert.equal(hit(mw, { baseUrl: '', path: '/a2', ip: '9.9.9.1' }), true);
  assert.equal(hit(mw, { baseUrl: '', path: '/A3', ip: '9.9.9.1' }), false);
});

test('two limiters do not share buckets', () => {
  const a = rateLimit({ windowMs: 60_000, max: 1 });
  const b = rateLimit({ windowMs: 60_000, max: 1 });
  const req = { baseUrl: '', path: '/', ip: '9.9.9.2' };
  assert.equal(hit(a, req), true);
  assert.equal(hit(b, req), true, 'b has its own count');
});

test('IPv6 clients are counted per /64, so rotating addresses inside it does not help', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  assert.equal(hit(mw, { baseUrl: '/z', ip: '2001:db8:1:2::1' }), true);
  assert.equal(hit(mw, { baseUrl: '/z', ip: '2001:db8:1:2:ffff::9' }), false);
  assert.equal(hit(mw, { baseUrl: '/z', ip: '2001:db8:1:3::1' }), true, 'another /64');
});

test('clientKey groups IPv6 by /64 and keeps IPv4 as is', () => {
  assert.equal(clientKey({ ip: '1.2.3.4' }), '1.2.3.4');
  assert.equal(clientKey({ ip: '::ffff:1.2.3.4' }), '1.2.3.4');
  assert.equal(clientKey({ ip: '2001:db8::1' }), '2001:db8:0:0::/64');
});
