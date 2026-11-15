// The app's callbacks name the server that made them (`iss`, RFC 9207 style), so the app can drop a
// callback another Sylo server sent it (mix-up attack), and the consent pages show the server's
// address. Here the server runs without DASHBOARD_URL, so the issuer is the address the browser used
// (a non-default port); test/mobileIssuer.configured.test.js covers a configured public URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  appOrigin,
  browser,
  getWithHost,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
  stateOf,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { pkceChallenge, createApiToken, revokeApiTokenValue } = await import('../src/db/apiTokens.js');
const { findIdentity } = await import('../src/db/accounts.js');

const ISSUER = appOrigin();
const PORT = new URL(ISSUER).port;
const DAY = 24 * 60 * 60 * 1000;
const STATE = 'st4te-From_the.app~1';
const EVIL_HOST = `evil&x'y.test:${PORT}`;
const challenge = () => pkceChallenge(randomBytes(48).toString('base64url'));
const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const decodeHtml = (s) => s.replaceAll('&amp;', '&');
const cancelHref = (html) => new URL(decodeHtml(/href="(sylo:\/\/[^"]+)"/.exec(html)[1]));
const issOf = (location) => new URL(location).searchParams.get('iss');
const errorOf = (location) => new URL(location).searchParams.get('error');

/** The sign-in up to the confirmation page; returns the page's HTML and the form's nonce. */
async function confirmPage(b, host = null) {
  const start = await b.get(`/auth/mobile/start?challenge=${challenge()}&state=${STATE}&platform=discord`);
  assert.equal(start.status, 302);
  if (start.headers.get('location') !== '/auth/mobile/confirm') await signIn(b, 'discord');
  const page = host
    ? await getWithHost(b, '/auth/mobile/confirm', host)
    : await b.get('/auth/mobile/confirm');
  assert.equal(page.status, 200);
  const html = host ? page.text : await page.text();
  return { html, nonce: /name="nonce" value="([^"]+)"/.exec(html)[1] };
}

test('the sign-in callback carries the code, the state and this server as iss', async () => {
  setProfiles();
  const b = browser();
  const { nonce } = await confirmPage(b);
  const allow = await b.get('/auth/mobile/confirm', form({ nonce }));
  assert.equal(allow.status, 302);
  const back = new URL(allow.headers.get('location'));
  assert.equal(`${back.protocol}//${back.host}`, 'sylo://auth');
  assert.equal(back.searchParams.get('state'), STATE);
  assert.match(back.searchParams.get('code'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(back.searchParams.get('iss'), ISSUER);
  assert.deepEqual([...back.searchParams.keys()].sort(), ['code', 'iss', 'state']);
  assert.ok(PORT, 'a non-default port is part of the issuer');
  assert.match(allow.headers.get('location'), /[?&]iss=http%3A%2F%2F127\.0\.0\.1%3A\d+(&|$)/, 'URL-encoded');
});

test('the sign-in Cancel link is an error callback that names the server too', async () => {
  setProfiles();
  const { html } = await confirmPage(browser());
  const cancel = cancelHref(html);
  assert.equal(cancel.host, 'auth');
  assert.equal(cancel.searchParams.get('error'), 'access_denied');
  assert.equal(cancel.searchParams.get('state'), STATE);
  assert.equal(cancel.searchParams.get('iss'), ISSUER);
});

test('the sign-in page names this server', async () => {
  setProfiles();
  const { html } = await confirmPage(browser());
  assert.ok(html.includes(`<code>${ISSUER}</code>`));
});

test('the sign-in page escapes the address it shows', async () => {
  setProfiles();
  // The issuer is built from the Host header when no public URL is configured. `&` and `'` are
  // allowed in a host name by the URL parser, and need escaping in HTML.
  const { html } = await confirmPage(browser(), EVIL_HOST);
  assert.ok(html.includes('http://evil&amp;x&#39;y.test:'), 'escaped on the page');
  assert.ok(!html.includes("evil&x'y"), 'never raw');
  assert.equal(cancelHref(html).searchParams.get('iss'), `http://${EVIL_HOST}`);
});

// --- adding the other login -----------------------------------------------------------------

async function person() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  const app = browser();
  const codeFor = async () => {
    const res = await app.get('/api/mobile/connect/fluxer', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()).code;
  };
  return { token, codeFor, fluxer: { ...profiles.fluxer } };
}

const connectPage = (b, code) => b.get(`/auth/mobile/connect?code=${encodeURIComponent(code)}`);
const nonceOf = async (res) => /continue\?nonce=([^"&]+)/.exec(await res.text())[1];

test('the connect page names this server and its Cancel link carries iss', async () => {
  const p = await person();
  const res = await connectPage(browser(), await p.codeFor());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`<code>${ISSUER}</code>`));
  const cancel = cancelHref(html);
  assert.equal(cancel.searchParams.get('error'), 'access-denied');
  assert.equal(cancel.searchParams.get('platform'), 'fluxer');
  assert.equal(cancel.searchParams.get('iss'), ISSUER);
});

test('the connect page escapes the address it shows', async () => {
  const p = await person();
  const res = await getWithHost(
    browser(),
    `/auth/mobile/connect?code=${encodeURIComponent(await p.codeFor())}`,
    EVIL_HOST
  );
  assert.equal(res.status, 200);
  const html = res.text;
  assert.ok(html.includes('http://evil&amp;x&#39;y.test:'));
  assert.ok(!html.includes("evil&x'y"));
});

test('the connect result callback carries iss', async () => {
  const p = await person();
  const sheet = browser();
  const cont = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${await nonceOf(await connectPage(sheet, await p.codeFor()))}`
  );
  profiles.fluxer = p.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(callback.status, 302);
  const back = new URL(callback.headers.get('location'));
  assert.equal(`${back.protocol}//${back.host}`, 'sylo://connected');
  assert.match(back.searchParams.get('result'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(back.searchParams.get('iss'), ISSUER);
  assert.match(callback.headers.get('location'), /[?&]iss=http%3A%2F%2F127\.0\.0\.1%3A\d+$/, 'URL-encoded');
});

test('every connect error callback carries iss', async () => {
  const p = await person();
  const sheet = browser();

  // The person declines at the platform.
  const cont = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${await nonceOf(await connectPage(sheet, await p.codeFor()))}`
  );
  const denied = await sheet.get(`/auth/fluxer/callback?error=access_denied&state=${stateOf(cont)}`);
  assert.equal(errorOf(denied.headers.get('location')), 'access-denied');
  assert.equal(issOf(denied.headers.get('location')), ISSUER);

  // The platform's answer does not check out.
  await sheet.get(
    `/auth/mobile/connect/continue?nonce=${await nonceOf(await connectPage(sheet, await p.codeFor()))}`
  );
  const bad = await sheet.get('/auth/fluxer/callback?code=abc&state=not-the-state');
  assert.equal(errorOf(bad.headers.get('location')), 'invalid-response');
  assert.equal(issOf(bad.headers.get('location')), ISSUER);

  // The app was signed out before the sheet opened.
  const code = await p.codeFor();
  await revokeApiTokenValue(p.token);
  const revoked = await connectPage(browser(), code);
  assert.equal(revoked.status, 302);
  assert.equal(errorOf(revoked.headers.get('location')), 'token-revoked');
  assert.equal(issOf(revoked.headers.get('location')), ISSUER);
});
