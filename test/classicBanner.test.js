// The public pages (sign-in, the app's confirm page, error, verify, appeal, leaderboard) carry no
// classic dashboard chrome: no htmx, Alpine, sidebar, retirement banner or inline script. They are
// standalone pages in the new dashboard's look (/public.css, /theme.js). This file runs with login
// enabled; test/publicPagesOpen.test.js covers open mode.
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { SAMPLES, capture, plainProblems, renderError, renderSample } from './helpers/publicViews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';

await startOAuthApp();
const { pkceChallenge } = await import('../src/db/apiTokens.js');
const { createApp, centralErrorHandler } = await import('../src/web/server.js');
const { forbidOwner } = await import('../src/web/middleware/auth.js');
const { ticketAccessLevel } = await import('../src/web/middleware/ticketAccess.js');
const { ticketsRouter } = await import('../src/web/routes/v2Staff.js');
const { log } = await import('../src/lib/log.js');
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
  const invalidText = await invalid.text();
  assert.doesNotMatch(
    invalidText,
    /Back to the dashboard/,
    'the app, not the dashboard, is where they go back to'
  );
  assertPlain(invalidText, 'mobile start');
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
  assert.match(text, /Sign-in failed/);
  assert.match(text, /<a class="btn btn-ghost" href="\/auth\/login">Try again<\/a>/);
  assertPlain(text, 'login failed');
});

test('a failed connect while signed in leads back to the Account page', async () => {
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get('/auth/discord/callback?code=x&state=not-the-state');
  assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
  const text = await res.text();
  assert.match(text, /Sign-in failed/);
  assert.match(text, /<a class="btn btn-ghost" href="\/v2\/account">Back to your account<\/a>/);
  assertPlain(text, 'connect failed');
});

test('an unknown address: signed out goes to sign-in, signed in gets the 404 page with the policy', async () => {
  const out = await browser().get('/no/such/page', { headers: { accept: 'text/html' } });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/auth/login');

  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get('/no/such/page', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const text = await res.text();
  assert.match(text, /Page not found/);
  assertPlain(text, 'unknown address');
  const json = await b.get('/api/nothing-here', { headers: { accept: 'text/html' } });
  assert.equal(json.status, 404);
  assert.deepEqual(await json.json(), { error: 'Not found' });
});

test('the error page from the public leaderboard (leaderboard.js) is plain', async () => {
  const res = await browser().get('/leaderboard/not-a-server');
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.match(text, /No leaderboard here/);
  assertPlain(text, 'leaderboard 404');
});

// The per-server guard (access.js) answers only JSON: it guards /api/v2 alone.
test('the error page from the operator guard (auth.js) is plain', async () => {
  const owner = await capture(app, (res) => forbidOwner(res));
  assert.equal(owner.status, 403);
  assert.match(owner.html, /Not an operator/);
  assertPlain(owner.html, 'forbidOwner');
});

test('the error page from the server error handler (server.js) is plain', async () => {
  const handler = centralErrorHandler;
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

// The ticket access guard (ticketAccess.js) is the first thing the tickets router of the v2 API runs
// (v2Staff.js). This mounts that router behind the server's own central error handler, with a
// signed-in account chosen per request, to test what the guard answers.
async function withTicketsRouter(run, { seen = [] } = {}) {
  const mini = express();
  mini.use((req, _res, next) => {
    req.account =
      req.get('x-lookup') === 'fails'
        ? {
            id: 'acc-1',
            get identities() {
              throw new Error('lookup failed: secret detail');
            },
          }
        : { id: 'acc-1', identities: [] };
    next();
  });
  mini.use('/guilds/:guildId/tickets', ticketsRouter);
  mini.use((err, req, res, next) => {
    seen.push(err);
    centralErrorHandler(err, req, res, next);
  });
  const server = await new Promise((resolve) => {
    const srv = mini.listen(0, () => resolve(srv));
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}/guilds/${D_GUILD}/tickets`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the ticket access guard refuses a person without access with a plain answer: no page, no data', async () => {
  await withTicketsRouter(async (url) => {
    for (const accept of ['text/html', 'application/json']) {
      const res = await fetch(url, { headers: { accept } });
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.text();
      assert.deepEqual(JSON.parse(body), {
        error: 'You need Manage Server, or a configured staff role, to view tickets here.',
      });
      assert.doesNotMatch(body, /<|htmx|alpine|sidebar/i);
    }
  });
});

test('a failed ticket access lookup goes to the error handler instead of hanging the request', async (t) => {
  const logged = t.mock.method(log, 'error', () => {});
  const failing = {
    id: 'acc-1',
    get identities() {
      throw new Error('lookup failed: secret detail');
    },
  };
  await assert.rejects(
    ticketAccessLevel({ account: failing, params: { guildId: D_GUILD }, method: 'GET' }),
    /lookup failed/,
    'the lookup rejects: a failure is not swallowed into a level'
  );
  const seen = [];
  await withTicketsRouter(
    async (url) => {
      const res = await fetch(url, {
        headers: { accept: 'text/html', 'x-lookup': 'fails' },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(res.status, 500, 'answered, not hung');
      assert.deepEqual(await res.json(), { error: 'Internal server error' }, 'no detail of the failure');
    },
    { seen }
  );
  assert.equal(seen.length, 1, 'the error reached the central error handler');
  assert.match(seen[0].message, /lookup failed/);
  assert.equal(logged.mock.callCount(), 1, 'recorded once, with the route pattern');
});
