// GET /api/v2/modules/limits: the setting limits of every module for the dashboard forms. Signed-in
// callers only; the answer is cacheable and answers 304 on a matching ETag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous } from './helpers/v2Guarded.js';

await startOAuthApp();
const { MODULE_LIMITS } = await import('../src/modules/limits.js');

async function signedIn() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  return (headers = {}) =>
    // fetch() adds "cache-control: no-cache" to a request with its own If-None-Match, which a
    // browser revalidating its cache does not send; max-age=0 is what a browser sends.
    b.get('/api/v2/modules/limits', {
      headers: { accept: 'application/json', 'cache-control': 'max-age=0', ...headers },
    });
}

test('signed out: refused, no limits in the answer', async () => {
  const res = await anonymous().get('/modules/limits');
  assert.ok([401, 403].includes(res.status), `status ${res.status}`);
  assert.doesNotMatch(await res.text(), /maxLength/);
});

test('signed in: answers with every module’s limits, an ETag and a private cache header', async () => {
  const get = await signedIn();
  const res = await get();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
  assert.ok(res.headers.get('etag'), 'has an ETag');

  const body = await res.json();
  assert.deepEqual(body, JSON.parse(JSON.stringify(MODULE_LIMITS)));
  assert.deepEqual(body.sticky['stickies[].content'], { maxLength: 2000 });
  assert.deepEqual(body.sticky['stickies[].cooldownSeconds'], { min: 0, max: 3600 });
  assert.deepEqual(body.sticky.stickies, { maxItems: 50 });
  assert.equal(body.welcome.joinMessage.maxLength, 1500);
  assert.equal(body.polls.voteRoles.maxItems, 25);
  assert.equal(body._embed.title.maxLength, 256);
});

test('a matching If-None-Match answers 304 with no body; another ETag gets the limits', async () => {
  const get = await signedIn();
  const first = await get();
  const etag = first.headers.get('etag');
  await first.arrayBuffer();

  const again = await get({ 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);

  const stale = await get({ 'if-none-match': '"something-else"' });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('etag'), etag, 'the ETag is the same on every call');
});
