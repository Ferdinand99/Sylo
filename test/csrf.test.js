import test from 'node:test';
import assert from 'node:assert/strict';
import { csrf, hasValidCsrfToken } from '../src/web/middleware/csrf.js';

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
    json(b) {
      this.body = b;
      this.isJson = true;
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

test('same-origin guard runs even in open mode', () => {
  // Cross-site Origin -> blocked.
  const blocked = mk({
    method: 'POST',
    session: undefined,
    headers: { host: 'sylo.lan', origin: 'https://evil.example' },
  });
  assert.equal(blocked.nexted, false);
  assert.equal(blocked.res.statusCode, 403);
  assert.match(blocked.res.body, /cross-origin/i);

  // Same Origin -> allowed. Same-site Referer -> allowed. Neither (curl) -> allowed.
  assert.equal(
    mk({ method: 'POST', session: undefined, headers: { host: 'sylo.lan', origin: 'http://sylo.lan' } })
      .nexted,
    true
  );
  assert.equal(
    mk({
      method: 'POST',
      session: undefined,
      headers: { host: 'sylo.lan', referer: 'http://sylo.lan/guilds/1/settings' },
    }).nexted,
    true
  );
  assert.equal(mk({ method: 'POST', session: undefined }).nexted, true);
});

test('GET with a session: mints a token and passes through', () => {
  const session = {};
  const { nexted } = mk({ method: 'GET', session });
  assert.equal(nexted, true);
  assert.ok(session.csrf && session.csrf.length >= 32);
});

test('POST without a token is rejected 403', () => {
  const session = { csrf: 'a'.repeat(48) };
  const { res, nexted } = mk({ method: 'POST', session });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /CSRF/i);
});

test('POST with a matching header passes; the old _csrf body field no longer does', () => {
  const session = { csrf: 'b'.repeat(48) };
  assert.equal(mk({ method: 'POST', session, headers: { 'x-csrf-token': session.csrf } }).nexted, true);
  assert.equal(mk({ method: 'POST', session, body: { _csrf: session.csrf } }).nexted, false);
});

test('POST with a wrong token is rejected', () => {
  const session = { csrf: 'c'.repeat(48) };
  assert.equal(mk({ method: 'POST', session, headers: { 'x-csrf-token': 'nope' } }).nexted, false);
});

test('the signed-token flows (/verify, /appeal, /auth) are exempt', () => {
  const session = { csrf: 'd'.repeat(48) };
  for (const path of ['/verify/abc', '/appeal/xyz', '/auth/discord/callback']) {
    assert.equal(mk({ method: 'POST', path, session }).nexted, true, path);
  }
});

// Logging out is a change too: another site must not be able to sign someone out.
// /auth runs before the csrf middleware, so the logout route checks the token with this.
test('hasValidCsrfToken: the session token, from the same origin', () => {
  const session = { csrf: 'e'.repeat(48) };
  const req = (headers) => ({ session, body: {}, get: (h) => headers[h.toLowerCase()] });
  assert.equal(hasValidCsrfToken(req({})), false);
  assert.equal(hasValidCsrfToken(req({ 'x-csrf-token': 'e'.repeat(48) })), true);
  assert.equal(hasValidCsrfToken(req({ 'x-csrf-token': 'x' })), false);
  assert.equal(
    hasValidCsrfToken(
      req({ 'x-csrf-token': 'e'.repeat(48), origin: 'https://evil.example', host: 'sylo.test' })
    ),
    false
  );
});

// The new dashboard reads JSON errors; a text/plain 403 showed up as "Unexpected response".
test('a failed check on an /api/ path answers JSON', () => {
  const { res } = mk({ method: 'POST', path: '/api/v2/guilds/1/x', session: { csrf: 'abc' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.isJson, true);
  assert.match(res.body.error, /CSRF/);
});
