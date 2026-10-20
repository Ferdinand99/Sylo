import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, profiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

// The public JSON healthcheck must not show the last error: its message can carry a server
// admin's feed URL or an internal address (a port-scan oracle). Operators still see it.
test('/health JSON shows the last error to operators only', async () => {
  const { runtime } = await import('../src/runtime.js');
  runtime.lastError = { message: 'rss: http://10.0.0.5/feed: ECONNREFUSED', scope: 'rss', at: Date.now() };
  const json = { headers: { accept: 'application/json' } };
  assert.equal('lastError' in (await (await browser().get('/health', json)).json()), false);

  profiles.discord = { id: '111111111111111111', username: 'ferdi', guilds: [] };
  const operator = browser();
  await signIn(operator, 'discord');
  assert.match((await (await operator.get('/health', json)).json()).lastError.message, /10\.0\.0\.5/);
  runtime.lastError = null;
});

// A bad %-sequence in the path used to throw in the shared view setup: a 500 for anyone, and an
// error posted to the dev-log channel for every such request.
test('a malformed URL is a 400, not a server error', async () => {
  const { runtime } = await import('../src/runtime.js');
  const before = runtime.errors.length;
  const res = await browser().get('/%E0%A4%A/x');
  assert.equal(res.status, 400);
  assert.equal(runtime.errors.length, before, 'nothing was logged as an error');
});

// An uptime monitor needs "errors right now", not "errors since the last restart": the ring
// buffer only empties on a restart, so one old error would keep a monitor down for good.
test('/health JSON says how many errors were logged in the last hour', async () => {
  const { runtime } = await import('../src/runtime.js');
  const saved = runtime.errors;
  runtime.errors = [
    { message: 'recent', scope: 'apple', at: Date.now() - 5 * 60_000 },
    { message: 'stale', scope: 'rss', at: Date.now() - 2 * 3_600_000 },
  ];
  const body = await (await browser().get('/health', { headers: { accept: 'application/json' } })).json();
  assert.equal(body.errorCount, 2);
  assert.equal(body.errorsLastHour, 1);
  runtime.errors = saved;
});
