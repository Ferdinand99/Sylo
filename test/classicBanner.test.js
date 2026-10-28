// The public pages (sign-in, the app's confirm page, error, verify, appeal, leaderboard) carry no
// classic dashboard chrome: no htmx, Alpine, sidebar, retirement banner or inline script. They are
// standalone pages in the new dashboard's look (/public.css, /theme.js). This file runs with login
// enabled; test/publicPagesOpen.test.js covers open mode.
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { SAMPLES, capture, plainProblems, renderError, renderSample } from './helpers/publicViews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

await startOAuthApp();
const { pkceChallenge } = await import('../src/db/apiTokens.js');
const { createApp } = await import('../src/web/server.js');
const { forbidOwner, requireGuildAdmin } = await import('../src/web/middleware/auth.js');
const { requireTicketAccess } = await import('../src/web/middleware/ticketAccess.js');
const { LimitError } = await import('../src/lib/limits.js');
const { RoleGrantError } = await import('../src/web/middleware/roleGrants.js');

const app = createApp();

function assertPlain(html, what) {
  assert.deepEqual(plainProblems(html), [], what);
}

for (const name of Object.keys(SAMPLES)) {
  test(`the ${name} page has no classic chrome and no inline script or style`, async () => {
    assertPlain(await renderSample(name), name);
  });
}

test('the leaderboard bar is a <meter> with the member progress, not an inline width', async () => {
  const html = await renderSample('leaderboard');
  assert.match(html, /<meter class="lb-bar" min="0" max="100" value="62"/);
  assert.doesNotMatch(html, /style=/);
});

test('the sign-in page is plain', async () => {
  const page = await browser().get('/auth/login');
  assert.equal(page.status, 200);
  assertPlain(await page.text(), 'login');
});

test('the app sign-in confirmation is plain, even when signed in', async () => {
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
  assertPlain(text, 'mobile-confirm');
});

test('the error page from the app sign-in (mobile.js) is plain', async () => {
  setProfiles();
  const b = browser();
  const invalid = await b.get('/auth/mobile/start?challenge=x&state=y');
  assert.equal(invalid.status, 400);
  assertPlain(await invalid.text(), 'mobile start');
  await signIn(b, 'discord');
  const expired = await b.get('/auth/mobile/confirm');
  assert.equal(expired.status, 400);
  const text = await expired.text();
  assert.match(text, /Sign-in expired/);
  assertPlain(text, 'mobile confirm expired');
});

test('the error page from a failed login (auth.js) is plain', async () => {
  const res = await browser().get('/auth/discord/callback?code=x&state=not-the-state');
  assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
  const text = await res.text();
  assert.match(text, /Login failed/);
  assertPlain(text, 'login failed');
});

test('the error page from the public leaderboard (leaderboard.js) is plain', async () => {
  const res = await browser().get('/leaderboard/not-a-server');
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.match(text, /No leaderboard here/);
  assertPlain(text, 'leaderboard 404');
});

test('the error page from the guild-admin and operator guards (auth.js) is plain', async () => {
  const account = { id: 'acc-1', identities: [] };
  const guard = await capture(app, (res) =>
    requireGuildAdmin(
      { account, params: { guildId: D_GUILD }, originalUrl: `/guilds/${D_GUILD}/x`, headers: {} },
      res,
      () => assert.fail('must not pass')
    )
  );
  assert.equal(guard.status, 403);
  assert.match(guard.html, /Not an admin/);
  assertPlain(guard.html, 'forbidGuild');

  const owner = await capture(app, (res) => forbidOwner(res));
  assert.equal(owner.status, 403);
  assert.match(owner.html, /Not an operator/);
  assertPlain(owner.html, 'forbidOwner');
});

test('the error page from the ticket access guard (ticketAccess.js) is plain', async () => {
  const out = await capture(app, (res) =>
    requireTicketAccess(
      { account: { id: 'acc-1', identities: [] }, params: { guildId: D_GUILD }, originalUrl: '/x' },
      res,
      () => assert.fail('must not pass')
    )
  );
  assert.equal(out.status, 403);
  assert.match(out.html, /No ticket access/);
  assertPlain(out.html, 'ticketAccess');
});

test('the error page from the server error handler (server.js) is plain', async () => {
  const handler = app.router.stack.map((l) => l.handle).find((h) => h.length === 4);
  assert.ok(handler, 'the central error handler');
  for (const err of [
    new LimitError('You reached the limit.'),
    new RoleGrantError('That role is above yours.'),
  ]) {
    const req = {
      method: 'POST',
      path: '/x',
      originalUrl: '/x',
      accepts: () => 'html',
      get: () => undefined,
    };
    const out = await capture(app, (res) => handler(err, req, res, () => assert.fail('handled')));
    assert.equal(out.status, err.status);
    assert.match(out.html, new RegExp(err.message.split(' ')[0]));
    assertPlain(out.html, err.constructor.name);
  }
});

test('the error page renders with and without a title, heading and message', async () => {
  assertPlain(await renderError({}), 'bare error');
  assertPlain(await renderError({ title: 'x', heading: 'y', message: 'z' }, { authEnabled: false }), 'error');
});
