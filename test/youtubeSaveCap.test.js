// Saving YouTube alerts looks up each channel handle on youtube.com, one request per row. The
// 50-alert limit used to apply only after every row was looked up, so one save with thousands
// of rows meant thousands of requests (and a YouTube block for the whole instance).
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

test('a save looks up at most 50 channels', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;

  const inner = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('youtube.com')) {
      lookups += 1;
      return new Response('not found', { status: 404 });
    }
    return inner(url, init);
  };
  try {
    const alerts = Array.from({ length: 300 }, (_, i) => ({ input: `@handle${i}` }));
    const res = await b.get(`/api/v2/guilds/${D_GUILD}/modules/youtube-alerts/config`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ alerts }),
    });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = inner;
  }
  assert.ok(lookups <= 50, `${lookups} lookups`);
});
