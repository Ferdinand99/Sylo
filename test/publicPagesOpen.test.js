// The public pages in open mode (no login): served as plain pages in the new dashboard's look, with
// their stylesheet, theme script and font served from the same origin. test/classicBanner.test.js
// covers the same pages with login enabled.
import { startWebApp } from './helpers/webApp.js';
import { capture, plainProblems } from './helpers/publicViews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let web;
let app;
test.before(async () => {
  web = await startWebApp();
  const { createApp } = await import('../src/web/server.js');
  app = createApp();
});
test.after(() => web.close());

const get = (path, headers) => fetch(web.base + path, { redirect: 'manual', headers });

test('public.css, theme.js and the font are served from the same origin', async () => {
  const css = await get('/public.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const text = await css.text();
  assert.match(text, /--accent: #8b7dff/);
  assert.match(text, /url\(\/fonts\/inter-latin-wght-normal\.woff2\)/);
  assert.doesNotMatch(text, /https?:\/\//, 'no external origin (no Google Fonts)');

  const js = await get('/theme.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const font = await get('/fonts/inter-latin-wght-normal.woff2');
  assert.equal(font.status, 200);
  assert.match(font.headers.get('content-type'), /font\/woff2/);
});

test('the verify page with a bad link is plain', async () => {
  const res = await get('/verify/900000000000000201?t=bad');
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /Verification failed/);
  assert.deepEqual(plainProblems(text), []);
});

test('the appeal page with a bad link is plain', async () => {
  const res = await get('/appeal/900000000000000201?t=bad');
  const text = await res.text();
  assert.match(text, /Something went wrong|Nothing to appeal/);
  assert.deepEqual(plainProblems(text), []);
});

test('the leaderboard error page is plain', async () => {
  const res = await get('/leaderboard/not-a-server');
  assert.equal(res.status, 404);
  assert.deepEqual(plainProblems(await res.text()), []);
});

test('the error page from the server error handler is plain in open mode too', async () => {
  const { LimitError } = await import('../src/lib/limits.js');
  const handler = app.router.stack.map((l) => l.handle).find((h) => h.length === 4);
  const req = { method: 'POST', path: '/x', originalUrl: '/x', accepts: () => 'html', get: () => undefined };
  const out = await capture(
    app,
    (res) => handler(new LimitError('Limit reached.'), req, res, () => assert.fail('handled')),
    { authEnabled: false }
  );
  assert.equal(out.status, 400);
  assert.deepEqual(plainProblems(out.html), []);
  assert.match(out.html, /href="\/v2\/"/, 'links back to the new dashboard');
});

test('/roadmap/posts.json is untouched and /roadmap moved for good', async () => {
  assert.equal((await get('/roadmap/posts.json')).status, 200);
  const moved = await get('/roadmap', { accept: 'text/html' });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), '/v2/roadmap');
});

// --- theme.js ----------------------------------------------------------------------------------

const themeJs = readFileSync(new URL('../src/web/public/theme.js', import.meta.url), 'utf8');

/** Run theme.js against a fake document and storage; returns the theme attribute and the storage. */
function runTheme(stored, { broken = false } = {}) {
  const store = new Map(Object.entries(stored));
  const attrs = {};
  const localStorage = broken
    ? {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      }
    : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  runInNewContext(themeJs, {
    localStorage,
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } },
  });
  return { attrs, store };
}

test('theme.js applies the saved V2 theme', () => {
  assert.equal(runTheme({ 'sylo:v2:theme': 'light' }).attrs['data-theme'], 'light');
  assert.equal(
    runTheme({ 'sylo:v2:theme': 'dark' }).attrs['data-theme'],
    undefined,
    'dark is the default look'
  );
});

test('theme.js falls back once to the old key, copies it over and leaves the old one alone', () => {
  const { attrs, store } = runTheme({ 'sylo:theme': 'light' });
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(store.get('sylo:v2:theme'), 'light');
  assert.equal(store.get('sylo:theme'), 'light');
});

test('the V2 key wins over the old one', () => {
  const { attrs, store } = runTheme({ 'sylo:v2:theme': 'dark', 'sylo:theme': 'light' });
  assert.equal(attrs['data-theme'], undefined);
  assert.equal(store.get('sylo:v2:theme'), 'dark');
});

test('theme.js ignores junk and survives blocked storage', () => {
  assert.equal(runTheme({ 'sylo:theme': 'purple' }).store.has('sylo:v2:theme'), false);
  assert.deepEqual(runTheme({}, { broken: true }).attrs, {});
});
