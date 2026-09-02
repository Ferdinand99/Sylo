import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/web/middleware/rateLimit.js';

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
