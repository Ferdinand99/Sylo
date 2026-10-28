// The "classic dashboard retires in Sylo 5.0" banner belongs on the classic dashboard's own pages,
// for a signed-in person (or in open mode). The sign-in, app sign-in, error and public pages share
// the header but do not show it.
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

await startOAuthApp();
const { pkceChallenge } = await import('../src/db/apiTokens.js');

const BANNER = /classic-retiring/;

test('the sign-in page does not show the banner', async () => {
  const page = await browser().get('/auth/login');
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), BANNER);
});

test('the app sign-in confirmation does not show the banner, even when signed in', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const challenge = pkceChallenge(randomBytes(48).toString('base64url'));
  const start = await b.get(
    `/auth/mobile/start?challenge=${challenge}&state=st4te-From_the.app~1&platform=discord`
  );
  assert.equal(start.headers.get('location'), '/auth/mobile/confirm');
  const page = await b.get('/auth/mobile/confirm');
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /Sign in to the app|Allow/i, 'it is the confirmation page');
  assert.doesNotMatch(text, BANNER);
});

test('a classic dashboard page shows the banner to a signed-in person', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const page = await b.get(`/guilds/${D_GUILD}/settings`); // not a browser page visit: stays classic
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, BANNER);
  assert.match(text, /removed in Sylo 5\.0/);
});

test('the public classic roadmap and an error page do not show it, signed in or not', async () => {
  const visitor = browser();
  assert.doesNotMatch(await (await visitor.get('/roadmap')).text(), BANNER);

  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.doesNotMatch(await (await b.get('/roadmap')).text(), BANNER);
  const missing = await b.get('/guilds/not-a-server-key/settings');
  assert.notEqual(missing.status, 200);
  assert.doesNotMatch(await missing.text(), BANNER);
});
