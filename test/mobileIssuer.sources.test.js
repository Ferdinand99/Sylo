// Where `iss` does not come from (a follow-up to test/mobileIssuer.test.js, in a file of its own so
// its requests have their own rate-limit buckets): not the request's query, not X-Forwarded-Host or
// X-Forwarded-Proto from an untrusted peer. Also that it is worked out before a one-time code is made.
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

const { pkceChallenge, createApiToken } = await import('../src/db/apiTokens.js');
const { findIdentity } = await import('../src/db/accounts.js');

const ISSUER = appOrigin();
const DAY = 24 * 60 * 60 * 1000;
const STATE = 'st4te-From_the.app~1';
const challenge = () => pkceChallenge(randomBytes(48).toString('base64url'));
const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const cancelHref = (html) => new URL(/href="(sylo:\/\/[^"]+)"/.exec(html)[1].replaceAll('&amp;', '&'));
const issOf = (location) => new URL(location).searchParams.get('iss');
const errorOf = (location) => new URL(location).searchParams.get('error');

/** The sign-in up to the confirmation page; returns the page's HTML and the form's nonce. */
async function confirmPage(b) {
  const start = await b.get(`/auth/mobile/start?challenge=${challenge()}&state=${STATE}&platform=discord`);
  assert.equal(start.status, 302);
  if (start.headers.get('location') !== '/auth/mobile/confirm') await signIn(b, 'discord');
  const html = await (await b.get('/auth/mobile/confirm')).text();
  return { html, nonce: /name="nonce" value="([^"]+)"/.exec(html)[1] };
}

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

// --- where iss does not come from ---------------------------------------------------------------

test('the provider-error callback carries iss too', async () => {
  const p = await person();
  const sheet = browser();
  const cont = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${await nonceOf(await connectPage(sheet, await p.codeFor()))}`
  );
  profiles.fluxer = { ...p.fluxer, tokenFails: true }; // the platform refuses the code exchange
  try {
    const failed = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
    assert.equal(failed.status, 302);
    assert.equal(errorOf(failed.headers.get('location')), 'provider-error');
    assert.equal(issOf(failed.headers.get('location')), ISSUER);
  } finally {
    profiles.fluxer = p.fluxer;
  }
});

test('an iss in the request is never used, anywhere in the sign-in', async () => {
  setProfiles();
  const evil = 'iss=https%3A%2F%2Fevil.test';
  const b = browser();
  await b.get(`/auth/mobile/start?challenge=${challenge()}&state=${STATE}&platform=discord&${evil}`);
  await signIn(b, 'discord');
  const page = await b.get(`/auth/mobile/confirm?${evil}`);
  const html = await page.text();
  assert.equal(cancelHref(html).searchParams.getAll('iss').join(), ISSUER);
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const allow = await b.get(`/auth/mobile/confirm?${evil}`, form({ nonce, iss: 'https://evil.test' }));
  assert.deepEqual(new URL(allow.headers.get('location')).searchParams.getAll('iss'), [ISSUER]);
});

test('an iss in the request is never used, anywhere in the connect flow', async () => {
  const p = await person();
  const evil = 'iss=https%3A%2F%2Fevil.test';
  const sheet = browser();
  const page = await sheet.get(`/auth/mobile/connect?code=${encodeURIComponent(await p.codeFor())}&${evil}`);
  const html = await page.text();
  assert.equal(cancelHref(html).searchParams.getAll('iss').join(), ISSUER);
  const nonce = /continue\?nonce=([^"&]+)/.exec(html)[1];
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${nonce}&${evil}`);
  profiles.fluxer = p.fluxer;
  const done = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}&${evil}`);
  assert.deepEqual(new URL(done.headers.get('location')).searchParams.getAll('iss'), [ISSUER]);

  const html2 = await (
    await sheet.get(`/auth/mobile/connect?code=${encodeURIComponent(await p.codeFor())}`)
  ).text();
  const cont2 = await sheet.get(
    `/auth/mobile/connect/continue?nonce=${/continue\?nonce=([^"&]+)/.exec(html2)[1]}`
  );
  const denied = await sheet.get(`/auth/fluxer/callback?error=access_denied&state=${stateOf(cont2)}&${evil}`);
  assert.deepEqual(new URL(denied.headers.get('location')).searchParams.getAll('iss'), [ISSUER]);
});

test('untrusted X-Forwarded-Host and X-Forwarded-Proto do not change iss', async () => {
  setProfiles();
  const forwarded = { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' };
  const b = browser();
  await b.get(`/auth/mobile/start?challenge=${challenge()}&state=${STATE}&platform=discord`, {
    headers: forwarded,
  });
  await signIn(b, 'discord');
  const page = await b.get('/auth/mobile/confirm', { headers: forwarded });
  const html = await page.text();
  assert.ok(html.includes(`<code>${ISSUER}</code>`));
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const allow = await b.get('/auth/mobile/confirm', {
    ...form({ nonce }),
    headers: { ...form({ nonce }).headers, ...forwarded },
  });
  assert.equal(issOf(allow.headers.get('location')), ISSUER);

  const p = await person();
  const connect = await b.get(`/auth/mobile/connect?code=${encodeURIComponent(await p.codeFor())}`, {
    headers: forwarded,
  });
  const connectHtml = await connect.text();
  assert.ok(connectHtml.includes(`<code>${ISSUER}</code>`));
  assert.equal(cancelHref(connectHtml).searchParams.get('iss'), ISSUER);
});

test('an unusable address fails before a one-time code is made', async () => {
  setProfiles();
  const b = browser();
  const { nonce } = await confirmPage(b);
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { prepare } = await import('../src/db/driver.js');
  const codes = async () =>
    (await prepare('SELECT * FROM mobile_codes WHERE account_id = ?').all(accountId)).length;
  assert.equal(await codes(), 0);
  const bad = await getWithHost(b, '/auth/mobile/confirm', 'bad host.test', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce }).toString(),
  });
  assert.ok(bad.status >= 400, 'no callback is sent');
  assert.ok(!bad.text.includes('sylo://auth?code'), 'and no code in a page');
  assert.equal(await codes(), 0, 'no code was made');
  // The flow was not used up: the person can still allow from the right address.
  const allow = await b.get('/auth/mobile/confirm', form({ nonce }));
  assert.equal(issOf(allow.headers.get('location')), ISSUER);
  assert.equal(await codes(), 1);
});
