// Wording and markup of the public pages: the 404 page, the error page's optional button, the
// verify and appeal pages, the leaderboard's progress label and the event page's spots. Rendered
// from the sample data the other public-page tests share (test/helpers/publicViews.js).
import { startWebApp } from './helpers/webApp.js';
import { SAMPLES, VIEWS, plainProblems, renderError, renderSample } from './helpers/publicViews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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
  // Only someone signed in (or on an open Sylo) gets here, so it is the dashboard's footer and way back.
  assert.doesNotMatch(html, /Powered by Sylo/);
  assert.match(html, /Back to the dashboard/);
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
  assert.match(lb, /Go to the Sylo home page/);
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
  // verify.js comes first and is a plain blocking script, so its callbacks exist whenever
  // Cloudflare's script renders the widget.
  assert.match(html, /<script src="\/verify\.js"><\/script>/);
  assert.ok(html.indexOf('/verify.js') < html.indexOf('challenges.cloudflare.com/turnstile/v0/api.js'));
  assert.doesNotMatch(html, /<script src="\/verify\.js"[^>]*(async|defer)/);
  assert.match(html, /id="verify-hint">Complete the check above to continue\./);
  assert.match(html, /id="verify-submit" aria-describedby="verify-hint"/);
  assert.match(html, /data-callback="syloTurnstileDone"/);
  assert.match(html, /id="verify-submit"/);

  const named = await render('verify.ejs', { ...SAMPLES['verify-challenge'].data, guildName: 'Hedgerow HQ' });
  assert.match(named, /<h1 class="page-title">Verify to join Hedgerow HQ<\/h1>/);
  assert.deepEqual(plainProblems(named), []);
});

test('verify.js: callbacks exist at once, and a pass before the page is parsed is not undone', () => {
  const src = readFileSync(new URL('../src/web/public/verify.js', import.meta.url), 'utf8');
  const button = { disabled: false };
  const hint = { hidden: false };
  let parsed = false;
  let onReady = null;
  const win = {};
  runInNewContext(src, {
    window: win,
    document: {
      getElementById: (id) => (parsed ? { 'verify-submit': button, 'verify-hint': hint }[id] : null),
      addEventListener: (type, fn) => {
        if (type === 'DOMContentLoaded') onReady = fn;
      },
    },
  });
  assert.equal(typeof win.syloTurnstileDone, 'function');
  assert.equal(typeof win.syloTurnstileReset, 'function');
  // The check passes before the page is parsed (no button to find yet); then the page is ready.
  win.syloTurnstileDone();
  parsed = true;
  onReady();
  assert.equal(button.disabled, false, 'passed already: stays on');
  assert.equal(hint.hidden, true);
  win.syloTurnstileReset(); // expired
  assert.equal(button.disabled, true);
  assert.equal(hint.hidden, false);
  win.syloTurnstileDone();
  assert.equal(button.disabled, false);
});

test('verify wording follows the server platform', async () => {
  const discord = await (await get('/verify/900000000000000201?t=bad')).text();
  assert.match(discord, /Click Verify again in Discord\./);
  const fluxer = await (await get('/verify/fluxer:900000000000000202?t=bad')).text();
  assert.match(fluxer, /Click Verify again in Fluxer\./);
  const done = await render('verify.ejs', { ...SAMPLES['verify-done'].data, platformName: 'Fluxer' });
  assert.match(done, /head back to Fluxer\./);
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
  // The server takes any one answer, so with several questions none is required on its own.
  assert.match(html, /<label for="appeal-a-0">Why were you banned\?<\/label>/);
  assert.match(html, /<label for="appeal-a-1">Why should we lift the ban\?<\/label>/);
  assert.match(
    html,
    /<textarea id="appeal-a-0" name="a" rows="3" maxlength="2000" aria-describedby="appeal-hint"><\/textarea>/
  );
  assert.doesNotMatch(html, / required>/);
  assert.match(html, /Answer at least one question\. Each answer can be up to 2,000 characters\./);

  const single = await render('appeal.ejs', { ...SAMPLES['appeal-form'].data, questions: ['Why?'] });
  assert.match(
    single,
    /<label for="appeal-a-0">Why\? <span class="muted small">\(required\)<\/span><\/label>/
  );
  assert.match(single, /aria-describedby="appeal-hint" required><\/textarea>/);
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
  assert.match(
    html,
    /<span class="lb-stat">41,200 XP<\/span> · <span class="lb-stat">3,012 messages<\/span>/
  );
  assert.doesNotMatch(html, /msgs/);
});

test('a member without a picture gets the initial of their name, and one message is not "1 messages"', async () => {
  const html = await renderSample('leaderboard');
  // the sample's fourth member (Pepper) has no avatar
  assert.match(html, /<span class="lb-avatar lb-avatar-blank" aria-hidden="true">P<\/span>/);
  const one = await ejs.renderFile(
    join(VIEWS, 'leaderboard.ejs'),
    {
      guild: { name: 'G', icon: null },
      total: 1,
      page: 1,
      pages: 1,
      period: 'all',
      canonical: '',
      members: [
        {
          rank: 1,
          name: 'solo',
          avatar: null,
          left: false,
          level: 1,
          pct: 5,
          xp: 10,
          messages: 1,
          voiceXp: 0,
          voiceMinutes: 0,
        },
      ],
    },
    {}
  );
  assert.match(one, /1 message<\/span>/);
  assert.match(one, />S<\/span>/);
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

test('the public leaderboard works the level and the percent out from the xp, rounding down', async () => {
  const { GID } = await import('./helpers/fakeGuild.js');
  const { setGuildModule } = await import('../src/db/modules.js');
  const { setXp } = await import('../src/db/leveling.js');
  const { levelProgress } = await import('../src/modules/lib/levels.js');
  await setGuildModule(GID, 'leveling', { enabled: true, config: {} });
  // The page looks its members up on the platform; none are found here.
  web.guild.client ??= { users: { fetch: async () => null } };
  const inner = web.guild.members.fetch;
  web.guild.members.fetch = async (arg) => (typeof arg === 'object' ? new Map() : inner(arg));
  // An xp that sits just under a whole percent of its level, where rounding would go up.
  let xp;
  let p;
  for (xp = 200; xp < 5000; xp += 1) {
    p = levelProgress(xp);
    if (p.pct * 100 - Math.floor(p.pct * 100) > 0.6) break;
  }
  await setXp(GID, '123456789012345001', xp);
  const html = await (await get(`/leaderboard/${GID}`)).text();
  assert.match(
    html,
    new RegExp(`<div class="lb-progress muted">${Math.floor(p.pct * 100)}% to level ${p.level + 1}</div>`)
  );
  assert.match(html, new RegExp(`<span class="lb-level">Level ${p.level}</span>`));
});
