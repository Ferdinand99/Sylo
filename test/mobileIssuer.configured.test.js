// With a public URL configured (DASHBOARD_URL, behind a reverse proxy) the issuer is that URL's
// origin: scheme, host and port, never the path or a trailing slash, and not the Host header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.SYLO_TEST_DASHBOARD_URL = 'http://Sylo.Example.com:8080/sub/path/';
const { browser, getWithHost, profiles, setProfiles, signIn, startOAuthApp, stateOf } =
  await import('./helpers/oauthApp.js');

await startOAuthApp();

const { config } = await import('../src/config.js');
const { pkceChallenge, createApiToken } = await import('../src/db/apiTokens.js');
const { findIdentity } = await import('../src/db/accounts.js');

// http, not https: a secure session cookie would not come back over the plain-http test server.
const ISSUER = 'http://sylo.example.com:8080';
const DAY = 24 * 60 * 60 * 1000;
const cancelHref = (html) => new URL(/href="(sylo:\/\/[^"]+)"/.exec(html)[1].replaceAll('&amp;', '&'));

test('the configured URL keeps its path, the issuer does not', () => {
  assert.equal(config.dashboardUrl, 'http://sylo.example.com:8080/sub/path');
});

test('sign-in callbacks (allow and cancel) carry the origin of the configured URL', async () => {
  setProfiles();
  const b = browser();
  const challenge = pkceChallenge(randomBytes(48).toString('base64url'));
  await b.get(`/auth/mobile/start?challenge=${challenge}&state=st4te-From_the.app~1&platform=discord`);
  await signIn(b, 'discord');
  const { text: html } = await getWithHost(b, '/auth/mobile/confirm', 'other.example.net');
  assert.ok(html.includes(`<code>${ISSUER}</code>`), 'the page shows the configured origin');
  assert.ok(!html.includes('other.example.net'), 'not the Host header');
  assert.equal(cancelHref(html).searchParams.get('iss'), ISSUER);

  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const allow = await b.get('/auth/mobile/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce }).toString(),
  });
  assert.equal(new URL(allow.headers.get('location')).searchParams.get('iss'), ISSUER);
});

test('connect callbacks (result and error) carry the origin of the configured URL', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  const fluxer = { ...profiles.fluxer };
  const app = browser();
  const codeFor = async () => {
    const res = await app.get('/api/mobile/connect/fluxer', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()).code;
  };

  const sheet = browser();
  const html = await (await sheet.get(`/auth/mobile/connect?code=${await codeFor()}`)).text();
  assert.ok(html.includes(`<code>${ISSUER}</code>`));
  assert.equal(cancelHref(html).searchParams.get('iss'), ISSUER);
  const cont = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${/continue\?nonce=([^"&]+)/.exec(html)[1]}`
  );
  profiles.fluxer = fluxer;
  const done = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  const back = new URL(done.headers.get('location'));
  assert.ok(back.searchParams.get('result'));
  assert.equal(back.searchParams.get('iss'), ISSUER);

  // An error callback: the same flow again, answered with an error by the platform.
  const html2 = await (await sheet.get(`/auth/mobile/connect?code=${await codeFor()}`)).text();
  const cont2 = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${/continue\?nonce=([^"&]+)/.exec(html2)[1]}`
  );
  const denied = await sheet.get(`/auth/fluxer/callback?error=access_denied&state=${stateOf(cont2)}`);
  const err = new URL(denied.headers.get('location'));
  assert.equal(err.searchParams.get('error'), 'access-denied');
  assert.equal(err.searchParams.get('iss'), ISSUER);
});
