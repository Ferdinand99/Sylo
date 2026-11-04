// Wording and markup of the public pages: the 404 page, the error page's optional button, the
// verify and appeal pages, the leaderboard's progress label and the event page's spots. Rendered
// from the sample data the other public-page tests share (test/helpers/publicViews.js).
import { startWebApp } from './helpers/webApp.js';
import { SAMPLES, VIEWS, plainProblems, renderError, renderSample } from './helpers/publicViews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ejs from 'ejs';

const web = await startWebApp();
test.after(() => web.close());

const get = (path, headers = {}) => fetch(web.base + path, { headers, redirect: 'manual' });
const render = (file, data) => ejs.renderFile(join(VIEWS, file), data);

// --- the 404 page -------------------------------------------------------------------------------

test('an unknown address gets the Sylo 404 page, not "Cannot GET"', async () => {
  const res = await get('/no/such/page', { accept: 'text/html' });
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.doesNotMatch(html, /Cannot GET/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /Page not found/);
  assert.match(html, /There&#39;s nothing at this address\./);
  assert.match(html, /Powered by Sylo/);
  assert.deepEqual(plainProblems(html), []);
});

test('an unknown /api or JSON-only request gets JSON', async () => {
  const api = await get('/api/no-such-thing', { accept: 'text/html' });
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'Not found' });

  const json = await get('/no/such/page', { accept: 'application/json' });
  assert.equal(json.status, 404);
  assert.deepEqual(await json.json(), { error: 'Not found' });
});

test('the public 404s have no dashboard button, a generic error still has one', async () => {
  const lb = await (await get('/leaderboard/not-a-server')).text();
  assert.match(lb, /No leaderboard here/);
  assert.doesNotMatch(lb, /Back to the dashboard/);
  assert.match(lb, /Powered by Sylo/);

  const q = await (await get('/quotes/not-a-server')).text();
  assert.doesNotMatch(q, /Back to the dashboard/);

  const withButton = await renderError({ title: 'Forbidden', heading: 'Not an admin', message: 'No.' });
  assert.match(withButton, /<a class="btn btn-ghost" href="\/v2\/">&larr; Back to the dashboard<\/a>/);
  assert.match(withButton, /auth-actions-inline/, 'an auto-width button, not a full-width bar');
  assert.match(withButton, /<a href="\/v2\/commands">Commands<\/a>/, 'the signed-in footer');
});

test('the error page can drop the button and take the public footer', async () => {
  const html = await renderError({
    heading: 'Gone',
    message: 'Nothing here.',
    backHref: null,
    publicPage: true,
  });
  assert.doesNotMatch(html, /Back to the dashboard/);
  assert.match(html, /Powered by Sylo/);
  assert.doesNotMatch(html, /Roadmap/);
});

// --- verify -------------------------------------------------------------------------------------

test('the verify page names the server, follows the theme and keeps the button off until the check passes', async () => {
  const html = await renderSample('verify-challenge');
  assert.match(html, /Verify to continue/, 'no server name known');
  assert.match(html, /data-theme="auto"/);
  assert.doesNotMatch(html, /data-theme="dark"/);
  assert.match(html, /<script src="\/verify\.js" defer><\/script>/);
  assert.match(html, /data-callback="syloTurnstileDone"/);
  assert.match(html, /id="verify-submit"/);

  const named = await render('verify.ejs', { ...SAMPLES['verify-challenge'].data, guildName: 'Hedgerow HQ' });
  assert.match(named, /<h1 class="page-title">Verify to join Hedgerow HQ<\/h1>/);
  assert.deepEqual(plainProblems(named), []);
});

test('a failed verification reads in the normal text colour', async () => {
  const html = await renderSample('verify-error');
  assert.match(html, /Verification failed/);
  assert.doesNotMatch(html, /warn-text/);
});

// --- appeal -------------------------------------------------------------------------------------

test('the appeal form ties each label to its box and says what is required and how long', async () => {
  const html = await renderSample('appeal-form');
  assert.match(html, /<p class="pub-eyebrow">Hedgerow HQ<\/p>/);
  assert.match(html, /<h1 class="page-title">Appeal your ban<\/h1>/);
  assert.match(html, /<p class="pub-callout">Bookmark this page: the decision will appear here\.<\/p>/);
  assert.match(
    html,
    /<label for="appeal-a-0">Why were you banned\? <span class="muted small">\(required\)<\/span><\/label>/
  );
  assert.match(
    html,
    /<label for="appeal-a-1">Why should we lift the ban\? <span class="muted small">\(optional\)<\/span><\/label>/
  );
  assert.match(
    html,
    /<textarea id="appeal-a-0" name="a" rows="3" maxlength="2000" aria-describedby="appeal-hint" required>/
  );
  assert.match(
    html,
    /<textarea id="appeal-a-1" name="a" rows="3" maxlength="2000" aria-describedby="appeal-hint" >/
  );
  assert.match(html, /up to 2,000 characters/);
});

test('an appeal error page has its own heading and normal-coloured text', async () => {
  const html = await render('appeal.ejs', {
    ...SAMPLES['appeal-form'].data,
    state: 'error',
    guildName: null,
    heading: "This appeal link isn't valid",
    message: 'This appeal link is invalid or has expired.',
  });
  assert.match(html, /This appeal link isn&#39;t valid/);
  assert.doesNotMatch(html, /warn-text/);
  assert.doesNotMatch(html, /pub-eyebrow/);

  const bare = await render('appeal.ejs', { ...SAMPLES['appeal-form'].data, state: 'error', message: 'x' });
  assert.match(bare, /Something went wrong/);
});

test('the bad appeal link answers with the specific heading', async () => {
  const res = await get('/appeal/900000000000000201?t=bad');
  assert.match(await res.text(), /This appeal link isn&#39;t valid/);
});

// --- leaderboard, event, sign-in ---------------------------------------------------------------

test('the leaderboard bar says how far to the next level and the stats keep their chunks whole', async () => {
  const html = await renderSample('leaderboard');
  assert.match(html, /aria-label="Progress to level 19"/);
  assert.match(html, /title="62% of the way to level 19"/);
  assert.match(html, /<div class="lb-progress muted">62% to level 19<\/div>/);
  assert.match(html, /<span class="lb-stat">41,200 XP<\/span> · <span class="lb-stat">3,012 msgs<\/span>/);
});

test('the event page counts spots', async () => {
  const html = await renderSample('event');
  assert.match(html, /<dd>3 of 10 spots<\/dd>/);
  const full = await renderSample('event-cancelled');
  assert.match(full, /of 10 spots · Full/);
});

test('every public page ends with the same "Powered by Sylo" line', async () => {
  for (const name of [
    'leaderboard',
    'quotes',
    'event',
    'verify-challenge',
    'appeal-form',
    'event-missing',
    'event-signin',
  ]) {
    assert.match(await renderSample(name), /Powered by Sylo/, name);
  }
});

test('sign-in uses one verb, Discord first', async () => {
  const login = await renderSample('login');
  assert.match(login, /Sign in to Sylo/);
  assert.match(login, /Sign in with Discord[\s\S]*Sign in with Fluxer/);
  assert.doesNotMatch(login, /Log in/);
  assert.match(await renderSample('event-signin'), /Sign in with Discord/);
});
