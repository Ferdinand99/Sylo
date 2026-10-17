// Signing in to the Sylo app (internal/mobile-api-plan.md, task 3): the app opens
// /auth/mobile/start in a browser sheet, the person signs in as usual and confirms, the server
// redirects to sylo://auth with a one-time code, and the app trades code + PKCE verifier for a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { pkceChallenge } = await import('../src/db/apiTokens.js');

const OWNER_ID = '111111111111111111';
const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
};
const STATE = 'st4te-From_the.app~1';

const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const nonceOf = (html) => /name="nonce" value="([^"]+)"/.exec(html)?.[1];

/** Run the browser part of the flow; returns the sylo:// redirect. */
async function browserFlow(b, challenge, { state = STATE } = {}) {
  const start = await b.get(`/auth/mobile/start?challenge=${challenge}&state=${state}&platform=discord`);
  assert.equal(start.status, 302);
  if (start.headers.get('location') === '/auth/discord/login') {
    const done = await signIn(b, 'discord');
    assert.equal(done.headers.get('location'), '/auth/mobile/confirm');
  } else {
    assert.equal(start.headers.get('location'), '/auth/mobile/confirm');
  }
  const page = await b.get('/auth/mobile/confirm');
  assert.equal(page.status, 200);
  const html = await page.text();
  const allow = await b.get('/auth/mobile/confirm', form({ nonce: nonceOf(html) }));
  return { html, allow };
}

const app = browser(); // the app itself: never holds a cookie
const tokenCall = (body) =>
  app.get('/api/mobile/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the whole flow: sign in, confirm, sylo:// with a code, code + verifier → a working token', async () => {
  profiles.discord = { id: OWNER_ID, username: 'owner', guilds: [] };
  const { verifier, challenge } = pkce();
  const b = browser();
  const { html, allow } = await browserFlow(b, challenge);
  assert.match(html, /owner/, 'the page says which account the app gets');
  assert.match(
    html,
    /sylo:\/\/auth\?error=access_denied&amp;state=st4te-From_the\.app%7E1/,
    'a way to cancel'
  );

  assert.equal(allow.status, 302);
  const back = new URL(allow.headers.get('location'));
  assert.equal(back.protocol, 'sylo:');
  assert.equal(back.host, 'auth');
  assert.equal(back.searchParams.get('state'), STATE);
  const code = back.searchParams.get('code');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  const res = await tokenCall({ code, verifier, deviceName: 'iPhone 18 Pro' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.token, /^sylo_/);
  assert.ok(body.expiresAt > Date.now());
  assert.deepEqual(body.account, { name: 'owner', avatar: null, platforms: ['discord'], owner: true });

  const me = await app.get('/api/v2/guilds', { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);

  const again = await tokenCall({ code, verifier, deviceName: 'x' });
  assert.equal(again.status, 400, 'a code works once');

  const out = await app.get('/api/mobile/token', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${body.token}` },
  });
  assert.equal(out.status, 204);
  const after = await app.get('/api/v2/guilds', { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(after.status, 401, 'signed out from the app');
});

test('the wrong verifier gets no token, and burns the code', async () => {
  setProfiles();
  const { verifier, challenge } = pkce();
  const { allow } = await browserFlow(browser(), challenge);
  const code = new URL(allow.headers.get('location')).searchParams.get('code');
  assert.equal((await tokenCall({ code, verifier: pkce().verifier })).status, 400);
  assert.equal((await tokenCall({ code, verifier })).status, 400);
});

test('a browser that is already signed in goes straight to the confirmation', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { verifier, challenge } = pkce();
  const { allow } = await browserFlow(b, challenge);
  const code = new URL(allow.headers.get('location')).searchParams.get('code');
  assert.equal((await tokenCall({ code, verifier, deviceName: 'iPad' })).status, 200);
});

test('confirming needs the nonce from the page (no cross-site "Allow")', async () => {
  setProfiles();
  const b = browser();
  const { challenge } = pkce();
  await b.get(`/auth/mobile/start?challenge=${challenge}&state=${STATE}&platform=discord`);
  await signIn(b, 'discord');
  for (const nonce of ['', 'guess']) {
    const res = await b.get('/auth/mobile/confirm', form({ nonce }));
    assert.equal(res.status, 403);
    assert.ok(!String(res.headers.get('location') ?? '').startsWith('sylo:'));
  }
});

test('bad start parameters are refused', async () => {
  const { challenge } = pkce();
  const b = browser();
  const bad = [
    `challenge=short&state=${STATE}`,
    `challenge=${challenge}`,
    `challenge=${challenge}&state=${encodeURIComponent('<script>')}`,
    `challenge=${challenge}&state=${'s'.repeat(200)}`,
    `challenge=${challenge}&state=${STATE}&platform=myspace`,
  ];
  for (const q of bad) assert.equal((await b.get(`/auth/mobile/start?${q}`)).status, 400, q);
});

test('the confirmation page without a started app sign-in is an error, not a code', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.equal((await b.get('/auth/mobile/confirm')).status, 400);
  assert.equal((await b.get('/auth/mobile/confirm', form({ nonce: 'x' }))).status, 403);
});

test('the token endpoint rejects a missing or malformed request', async () => {
  for (const body of [{}, { code: 'x' }, { verifier: 'y' }, { code: 1, verifier: 2 }]) {
    const res = await tokenCall(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.headers.get('content-type'), /json/);
  }
});

test('Allow pressed again after the sign-in finished says so, instead of a failure', async () => {
  setProfiles();
  const b = browser();
  const { challenge } = pkce();
  const { html, allow } = await browserFlow(b, challenge);
  assert.match(allow.headers.get('location'), /^sylo:/);
  // The browser could not open the app (or the person pressed again): same nonce, same page.
  const again = await b.get('/auth/mobile/confirm', form({ nonce: nonceOf(html) }));
  assert.equal(again.status, 409);
  assert.match(await again.text(), /already (complete|finished)/i);
  const reload = await b.get('/auth/mobile/confirm');
  assert.equal(reload.status, 409);
  // Starting over from the app works as before.
  const restart = await b.get(`/auth/mobile/start?challenge=${challenge}&state=${STATE}&platform=discord`);
  assert.equal(restart.headers.get('location'), '/auth/mobile/confirm');
  assert.equal((await b.get('/auth/mobile/confirm')).status, 200);
});

test('start: an inherited property name as platform is a 400, not a 500', async () => {
  const { challenge } = pkce();
  for (const platform of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const res = await browser().get(
      `/auth/mobile/start?challenge=${challenge}&state=${STATE}&platform=${platform}`
    );
    assert.equal(res.status, 400, platform);
  }
});

test('the app sign-in pages refuse to be framed', async () => {
  // Any answer from these pages carries it (this file may have used up the rate limit by now).
  const page = await browser().get('/auth/mobile/confirm');
  assert.ok([400, 429].includes(page.status), String(page.status));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});
