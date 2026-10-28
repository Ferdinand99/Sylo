// The dashboard lives at /v2 and nothing else: a signed-in person's visit to / goes there, and so
// does the ?classic=1 of the old "Back to classic dashboard" link. (Open mode: v2DefaultOpen.test.js.
// Old addresses: classicRedirect.test.js.)
import { browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Build } from '../src/web/routes/v2Client.js';

await startOAuthApp();

// Pretend the SPA is built, whatever the checkout has in web-v2/dist.
let built = true;
v2Build.exists = () => built;

async function signedIn() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  return b;
}

const goesToV2 = (res) => res.status === 302 && res.headers.get('location') === '/v2';

test('GET / redirects to /v2 for a signed-in person', async () => {
  const b = await signedIn();
  assert.ok(goesToV2(await b.get('/', { headers: { accept: 'text/html' } })));
});

test('the classic dashboard link ?classic=1 no longer exists: it opens /v2 too', async () => {
  const b = await signedIn();
  assert.ok(goesToV2(await b.get('/?classic=1', { headers: { accept: 'text/html' } })));
});

test('GET / goes to /v2 whatever the Accept header says', async () => {
  const b = await signedIn();
  assert.ok(goesToV2(await b.get('/', { headers: { accept: 'application/json' } })));
  assert.ok(goesToV2(await b.get('/', { headers: { accept: '*/*' } })));
});

test('signed out, GET / asks for a login first, not /v2', async () => {
  const res = await browser().get('/', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/auth\//);
});

test('no V2 build: / still goes to /v2, which answers a plain-text 503 that says how to build it', async () => {
  const b = await signedIn();
  built = false;
  try {
    assert.ok(goesToV2(await b.get('/', { headers: { accept: 'text/html' } })));
    const page = await b.get('/v2/guilds', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type'), /text\/plain/);
    assert.match(await page.text(), /npm run build:v2/);
  } finally {
    built = true;
  }
});
