// "Open the new dashboard by default": a signed-in person whose saved preference is V2 is sent
// from / to /v2, unless they chose "Back to classic dashboard" (/?classic=1) this session.
import { browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Build } from '../src/web/routes/v2Client.js';

await startOAuthApp();

// Pretend the SPA is built, whatever the checkout has in web-v2/dist.
let built = true;
v2Build.exists = () => built;

async function signedIn(version) {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { token } = await (await b.get('/api/v2/csrf')).json();
  const res = await b.get('/api/v2/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ dashboardVersion: version }),
  });
  assert.equal(res.status, 200);
  return b;
}

const home = (b, headers = {}) => b.get('/', { headers: { accept: 'text/html', ...headers } });
const goesToV2 = (res) => res.status === 302 && res.headers.get('location') === '/v2';

test('preference v2: GET / redirects to /v2', async () => {
  const b = await signedIn('v2');
  assert.ok(goesToV2(await home(b)));
});

test('preference v1: GET / stays on the classic dashboard', async () => {
  const b = await signedIn('v1');
  assert.ok(!goesToV2(await home(b)));
});

test('?classic=1 keeps the classic dashboard for the session, until /v2 is opened', async () => {
  const b = await signedIn('v2');
  assert.ok(!goesToV2(await b.get('/?classic=1', { headers: { accept: 'text/html' } })));
  assert.ok(!goesToV2(await home(b)), 'a later visit to / stays on classic');
  await b.get('/v2/guilds');
  assert.ok(goesToV2(await home(b)), 'opening /v2 cleared the classic choice');
});

test('htmx and JSON requests to / are never redirected to /v2', async () => {
  const b = await signedIn('v2');
  assert.ok(!goesToV2(await home(b, { 'HX-Request': 'true' })));
  assert.ok(!goesToV2(await b.get('/', { headers: { accept: 'application/json' } })));
});

test('no V2 build: GET / is not redirected', async () => {
  const b = await signedIn('v2');
  built = false;
  try {
    assert.ok(!goesToV2(await home(b)));
  } finally {
    built = true;
  }
});
