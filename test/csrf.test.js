import test from 'node:test';
import assert from 'node:assert/strict';
import { csrf } from '../src/web/middleware/csrf.js';

function mk({ method = 'GET', path = '/guilds/1/general', session, headers = {}, body = {} } = {}) {
  const res = {
    locals: {},
    statusCode: 200,
    body: null,
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
  const req = {
    method,
    path,
    session,
    body,
    get: (h) => headers[h.toLowerCase()],
  };
  let nexted = false;
  csrf(req, res, () => {
    nexted = true;
  });
  return { req, res, nexted };
}

test('open mode (no session): passes through, no token', () => {
  const { res, nexted } = mk({ method: 'POST', session: undefined });
  assert.equal(nexted, true);
  assert.equal(res.locals.csrfToken, undefined);
});

test('GET with a session: mints a token, exposes it, passes through', () => {
  const session = {};
  const { res, nexted } = mk({ method: 'GET', session });
  assert.equal(nexted, true);
  assert.ok(session.csrf && session.csrf.length >= 32);
  assert.equal(res.locals.csrfToken, session.csrf);
});

test('POST without a token is rejected 403', () => {
  const session = { csrf: 'a'.repeat(48) };
  const { res, nexted } = mk({ method: 'POST', session });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /CSRF/i);
});

test('POST with a matching header or body field passes', () => {
  const session = { csrf: 'b'.repeat(48) };
  assert.equal(mk({ method: 'POST', session, headers: { 'x-csrf-token': session.csrf } }).nexted, true);
  assert.equal(mk({ method: 'POST', session, body: { _csrf: session.csrf } }).nexted, true);
});

test('POST with a wrong token is rejected', () => {
  const session = { csrf: 'c'.repeat(48) };
  assert.equal(mk({ method: 'POST', session, body: { _csrf: 'nope' } }).nexted, false);
});

test('the signed-token flows (/verify, /appeal, /auth) are exempt', () => {
  const session = { csrf: 'd'.repeat(48) };
  for (const path of ['/verify/abc', '/appeal/xyz', '/auth/logout']) {
    assert.equal(mk({ method: 'POST', path, session }).nexted, true, path);
  }
});
