// A server's own look on its public member pages through the dashboard API and the public files: the upload
// (limits, kind by magic bytes, metadata gone, a re-encoded WebP), the invite splash (a copy Sylo downloads from a
// fake CDN and serves itself), the style sheet and picture addresses (guild-scoped, named by hash, immutable, no
// cookie, a plain 404 for everything else), the contrast fallback, what the public pages render (the accent, the
// background, always the "Powered by Sylo" link) and what the purge removes. Who may change it (Edit only, on the
// web and in the app, across servers) is in v2.accessLevels.test.js.
process.env.ALLOW_PRIVATE_URLS = 'true'; // the fake CDN below listens on 127.0.0.1
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { startWebApp } = await import('./helpers/webApp.js');
const { v2Open, auditRows } = await import('./helpers/v2Open.js');
const { GID } = await import('./helpers/fakeGuild.js');
const { makePicture, pngClaiming, upload, HTML, SVG } = await import('./helpers/collectibleFixtures.js');
const { db } = await import('../src/db/index.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { signAppealToken } = await import('../src/modules/appeals.js');
const { imageDimensions } = await import('../src/lib/imageSize.js');
const { refreshSplash, SPLASH_REFRESH_MS, lookRef, _resetSplashRetry } =
  await import('../src/web/lib/publicLook.js');
const { getLookImageMeta, getPublicLook, putLookImage, setPublicLook } =
  await import('../src/db/publicLook.js');
const { imageHashOf } = await import('../src/lib/publicLook.js');

let app;
let api;
let cdn;
let cdnHits = 0;
let cdnBody;
let cdnStatus = 200;
const USER = '444444444444444444';
const OTHER = '900000000000000777';

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  cdn = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      cdnHits += 1;
      res.writeHead(cdnStatus, { 'content-type': 'image/webp' });
      res.end(cdnBody);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  app.guild.splashURL = () => `http://127.0.0.1:${cdn.address().port}/splash.webp`;
});
test.after(() => {
  cdn.closeAllConnections?.();
  cdn.close();
  app.close();
});
beforeEach(async () => {
  await purgeGuild(GID);
  await purgeGuild(OTHER);
  app.guild.splash = null;
  cdnHits = 0;
  cdnStatus = 200;
  _resetSplashRetry();
});

const json = (res) => res.json();
const get = (path) => fetch(`${app.base}${path}`);
const putFile = (form) =>
  fetch(`${app.base}/api/v2/guilds/${GID}/public-page-look/image`, { method: 'POST', body: form });
const save = (body) => api.post('/public-page-look', body);
const rows = () =>
  db
    .prepare('SELECT source, hash, mime, bytes, origin FROM public_look_images WHERE guild_id = ?')
    .all(GID)
    .map((r) => ({ ...r }));
const view = async () => json(await api.get('/public-page-look'));
const pic = (w, h, format = 'png') => makePicture(w, h, format);
const hashOf = (path) => /\.([0-9a-f]{16})\.(css|webp)$/.exec(path)[1];

/** A JPEG with an EXIF segment (a made-up GPS note) and bytes appended after the picture, like a phone photo. */
async function jpegWithMetadata() {
  const jpeg = await pic(300, 200, 'jpeg');
  const body = Buffer.from('Exif\0\0SECRET-GPS-NOTE-48.8584N-2.2945E');
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, 0, body.length + 2]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2), Buffer.from('TRAILING-SECRET')]);
}

test('a server that chose nothing has the plain Sylo look, and the view says what is on offer', async () => {
  const v = await view();
  assert.equal(v.accent, '');
  assert.equal(v.background, 'none');
  assert.equal(v.upload, null);
  assert.deepEqual(v.splash, { available: false, copied: null });
  assert.equal(v.effective.css, null);
  assert.equal(v.effective.backgroundUrl, null);
  assert.deepEqual(v.effective.fallback, []);
  assert.equal(v.effective.note, null);
  assert.equal(v.platform, 'discord');
  assert.equal(v.limits.maxBytes, 2 * 1024 * 1024);
});

test('saving an accent and a background: checked, stored, audited, and the style sheet follows', async () => {
  const bad = await save({ accent: 'red', background: 'none' });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /#5865f2/);
  assert.equal((await save({ accent: '#5865f2', background: 'sparkles' })).status, 400);
  assert.equal((await save({ accent: '#5865f2', background: 'upload' })).status, 400, 'no picture yet');
  assert.equal((await save({ accent: '#5865f2', background: 'discord-splash' })).status, 400, 'no splash');
  assert.deepEqual(await getPublicLook(GID), { accent: '', background: 'none', updatedAt: 0 });

  const ok = await save({ accent: '#5865F2', background: 'none' });
  assert.equal(ok.status, 200);
  const v = await json(ok);
  assert.equal(v.accent, '#5865f2');
  assert.match(v.effective.css, new RegExp(`^/look/${GID}\\.[0-9a-f]{16}\\.css$`));
  const css = await get(v.effective.css);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(css.headers.get('set-cookie'), null, 'no session, no cookie');
  const text = await css.text();
  assert.match(text, /--accent: #5865f2/);
  assert.doesNotMatch(text, /--look-image/);
  assert.equal((await auditRows(GID, 'settings:public-look')).length, 1);

  // Clearing both gives the plain look back, and the old style sheet address is gone.
  const old = v.effective.css;
  const cleared = await json(await save({ accent: '', background: 'none' }));
  assert.equal(cleared.effective.css, null);
  assert.equal((await get(old)).status, 404, 'a stale address is a 404, never a stale look');
});

test("an accent that is too hard to read on the card falls back to Sylo's colour, and the answer says so", async () => {
  const v = await json(await save({ accent: '#ffe14d', background: 'none' }));
  assert.deepEqual(v.effective.fallback, ['light']);
  assert.match(v.effective.note, /too hard to read on the card in the light theme/);
  assert.equal(v.effective.accent.dark, '#ffe14d');
  assert.equal(v.effective.accent.light, v.sylo.accent.light);
  const css = await (await get(v.effective.css)).text();
  assert.match(css, /^:root \{ --accent: #ffe14d;/m);
  assert.doesNotMatch(css, /data-theme/, "the light theme keeps Sylo's own colour");

  const dark = await json(await save({ accent: '#1a2a6c', background: 'none' }));
  assert.deepEqual(dark.effective.fallback, ['dark']);
  assert.match(dark.effective.note, /in the dark theme/);
  const blurple = await json(await save({ accent: '#5865f2', background: 'none' }));
  assert.deepEqual(blurple.effective.fallback, [], 'a mid-tone reads on both cards');
  assert.equal(blurple.effective.note, null);
});

test('an upload becomes a WebP of at most 1920 px with the metadata gone, served from Sylo by its hash', async () => {
  const original = await jpegWithMetadata();
  assert.ok(original.includes('SECRET-GPS-NOTE'));
  const res = await putFile(upload(original, { name: 'phone.jpg', type: 'image/jpeg' }));
  assert.equal(res.status, 200);
  const v = await json(res);
  assert.match(v.upload.url, new RegExp(`^/look/${GID}\\.[0-9a-f]{16}\\.webp$`));

  const [stored] = rows();
  assert.equal(stored.source, 'upload');
  assert.equal(stored.mime, 'image/webp');
  const served = await get(v.upload.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(served.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(served.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(served.headers.get('set-cookie'), null);
  const body = Buffer.from(await served.arrayBuffer());
  assert.equal(imageHashOf(body), stored.hash);
  assert.equal(body.toString('latin1', 0, 4), 'RIFF');
  assert.ok(!body.includes('SECRET'), 'no EXIF note and no appended bytes');
  assert.deepEqual(imageDimensions(body), { width: 300, height: 200 });

  // A big picture is scaled down to fit in 1920 px.
  const big = await json(await putFile(upload(await pic(4000, 1000))));
  const bigBody = Buffer.from(await (await get(big.upload.url)).arrayBuffer());
  assert.deepEqual(imageDimensions(bigBody), { width: 1920, height: 480 });
  // The upload does not change the choice by itself.
  assert.equal(big.background, 'none');
});

test('the upload refuses what is not a picture, what is too large and what claims too many pixels', async () => {
  const refuse = async (form, status, text) => {
    const res = await putFile(form);
    assert.equal(res.status, status, String(text));
    assert.match((await json(res)).error, text);
    assert.equal(rows().length, 0, 'nothing stored');
  };
  await refuse(upload(SVG, { name: 'x.svg', type: 'image/svg+xml' }), 400, /PNG, JPEG or WebP/);
  await refuse(upload(HTML, { name: 'x.png', type: 'image/png' }), 400, /PNG, JPEG or WebP/);
  await refuse(upload(pngClaiming(30000, 30000)), 400, /too large in pixels/);
  const huge = Buffer.concat([pngClaiming(10, 10), Buffer.alloc(2 * 1024 * 1024)]);
  await refuse(upload(huge), 413, /larger than 2 MB/);
  const noField = new FormData();
  noField.append('other', new Blob(['x']), 'x.png');
  await refuse(noField, 400, /Choose an image/);
  const plain = await fetch(`${app.base}/api/v2/guilds/${GID}/public-page-look/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(plain.status, 415);
});

test('replacing the picture deletes the old one, and removing it sets a picture background back to none', async () => {
  const first = await json(await putFile(upload(await pic(64, 64, 'png'))));
  const firstUrl = first.upload.url;
  const second = await json(await putFile(upload(await pic(96, 48, 'png'))));
  assert.notEqual(second.upload.url, firstUrl);
  assert.equal(rows().length, 1, 'one picture per source: the old file is gone');
  assert.equal((await get(firstUrl)).status, 404);
  assert.equal((await get(second.upload.url)).status, 200);

  const chosen = await json(await save({ accent: '#5865f2', background: 'upload' }));
  const css = chosen.effective.css;
  assert.equal((await get(css)).status, 200);
  const v = await json(await api.post('/public-page-look/image/delete'));
  assert.equal(v.upload, null);
  assert.equal(v.background, 'none');
  assert.equal(rows().length, 0);
  assert.equal((await get(second.upload.url)).status, 404);
  assert.equal((await get(css)).status, 404, 'the old style sheet named the deleted picture');
});

test('a picture background is in the style sheet with a same-origin address, and the CSP is untouched', async () => {
  const up = await json(await putFile(upload(await pic(200, 100))));
  const v = await json(await save({ accent: '#5865f2', background: 'upload' }));
  assert.equal(v.effective.backgroundUrl, up.upload.url);
  const css = await (await get(v.effective.css)).text();
  assert.ok(css.includes(`--look-image: url('${up.upload.url}')`));
  assert.doesNotMatch(css, /https?:|\/\//, 'no other origin');
  const page = await get(`/quotes/${GID}`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: https:/, 'unchanged by the look');
  assert.match(csp, /style-src 'self'(;|$)/);
});

test('the files answer only for this server and the exact hash; everything else is the same plain 404', async () => {
  const up = await json(await putFile(upload(await pic(40, 40))));
  const v = await json(await save({ accent: '#5865f2', background: 'upload' }));
  const hash = hashOf(up.upload.url);
  const cssHash = hashOf(v.effective.css);
  // another server's address with this server's hashes
  assert.equal((await get(`/look/${OTHER}.${hash}.webp`)).status, 404);
  assert.equal((await get(`/look/${OTHER}.${cssHash}.css`)).status, 404);
  // a server with a look of its own has its own hashes only
  await setPublicLook(OTHER, { accent: '#5865f2', background: 'none' });
  assert.equal(
    (await get(`/look/${OTHER}.${cssHash}.css`)).status,
    404,
    'this look names a picture it lacks'
  );
  assert.equal((await get(`/look/${GID}.${cssHash}.css`)).status, 200);
  for (const bad of [
    `/look/${GID}.0000000000000000.webp`,
    `/look/${GID}.${hash}.png`,
    `/look/${GID}.${hash}.WEBP`,
    `/look/${GID}.${hash}.webp/`,
    `/look/${GID}.${hash.slice(1)}.webp`,
    `/look/fluxer-${GID}.${hash}.webp`,
    `/look/${GID}`,
    `/look/`,
    `/look/..%2fx.${hash}.webp`,
  ]) {
    const res = await get(bad);
    assert.equal(res.status, 404, bad);
    assert.equal(res.headers.get('cache-control'), 'no-store', bad);
    assert.equal(await res.text(), 'Not found', bad);
  }
});

test('the invite background: a copy downloaded once from the CDN, served by Sylo, checked daily, dropped when gone', async () => {
  cdnBody = await pic(800, 450, 'webp');
  app.guild.splash = 'splash-hash-1';
  const first = await view();
  assert.equal(first.splash.available, true);
  assert.equal(first.splash.copied, null, 'nothing is downloaded until the server chooses it');
  assert.equal(cdnHits, 0);

  const saved = await json(await save({ accent: '', background: 'discord-splash' }));
  assert.equal(cdnHits, 1);
  assert.match(saved.splash.copied.url, new RegExp(`^/look/${GID}\\.[0-9a-f]{16}\\.webp$`));
  assert.equal(saved.effective.backgroundUrl, saved.splash.copied.url);
  const served = await get(saved.splash.copied.url);
  assert.equal(served.status, 200);
  assert.deepEqual(imageDimensions(Buffer.from(await served.arrayBuffer())), { width: 800, height: 450 });
  assert.equal((await getLookImageMeta(GID, 'splash')).origin, 'splash-hash-1');

  // The same splash on the platform: no second download, only marked as checked.
  const later = Date.now() + SPLASH_REFRESH_MS + 1000;
  assert.equal((await refreshSplash(app.guild, { now: later })).status, 'unchanged');
  assert.equal(cdnHits, 1);
  assert.equal((await getLookImageMeta(GID, 'splash')).checkedAt, later);

  // A new splash on the platform is downloaded again and replaces the copy.
  cdnBody = await pic(640, 360, 'webp');
  app.guild.splash = 'splash-hash-2';
  assert.equal((await refreshSplash(app.guild, { force: true })).status, 'updated');
  assert.equal(cdnHits, 2);
  assert.equal(rows().filter((r) => r.source === 'splash').length, 1);
  assert.equal((await get(saved.splash.copied.url)).status, 404, 'the old copy is gone');

  // The explicit check route does the same job.
  assert.equal((await api.post('/public-page-look/splash/refresh')).status, 200);

  // The server removes its splash: the copy goes and a splash background shows nothing.
  app.guild.splash = null;
  assert.equal((await refreshSplash(app.guild, { force: true })).status, 'none');
  assert.equal(rows().length, 0);
  const after = await view();
  assert.equal(after.effective.backgroundUrl, null);
  assert.equal(after.splash.available, false);
});

test('a splash that cannot be downloaded or is not a picture keeps the old copy; choosing it then is refused', async () => {
  cdnBody = await pic(100, 100, 'webp');
  app.guild.splash = 'a';
  await save({ accent: '', background: 'discord-splash' });
  const before = (await getLookImageMeta(GID, 'splash')).hash;

  app.guild.splash = 'b';
  cdnStatus = 500;
  assert.equal((await refreshSplash(app.guild, { force: true })).status, 'failed');
  assert.equal((await getLookImageMeta(GID, 'splash')).hash, before);

  cdnStatus = 200;
  cdnBody = SVG;
  const refused = await refreshSplash(app.guild, { force: true });
  assert.equal(refused.status, 'failed');
  assert.match(refused.message, /PNG, JPEG or WebP/);
  assert.equal((await getLookImageMeta(GID, 'splash')).hash, before);

  // A server with no copy yet, whose splash cannot be fetched: the choice is refused and nothing is saved.
  await purgeGuild(GID);
  const res = await save({ accent: '#5865f2', background: 'discord-splash' });
  assert.equal(res.status, 502);
  assert.equal((await getPublicLook(GID)).background, 'none');
});

test('a page view of a splash server copies the splash in the background, once, and not again while it is fresh', async () => {
  cdnBody = await pic(100, 100, 'webp');
  app.guild.splash = 'x';
  await setPublicLook(GID, { accent: '', background: 'discord-splash' });
  await setGuildModule(GID, 'quote-board', { enabled: true, config: { publicPage: true } });
  assert.equal((await get(`/quotes/${GID}`)).status, 200);
  for (let i = 0; i < 50 && cdnHits === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(cdnHits, 1, 'the first view copies it');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await get(`/quotes/${GID}`)).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cdnHits, 1, 'a fresh copy is not downloaded again');
  const page = await (await get(`/quotes/${GID}`)).text();
  assert.match(page, /has-look has-look-image/, 'the page shows it once the copy is there');
});

test('the public pages take the accent and the background, and always end with the Powered by Sylo link', async () => {
  await setGuildModule(GID, 'quote-board', { enabled: true, config: { publicPage: true } });
  await setGuildModule(GID, 'appeals', { enabled: true });
  const link = /<a href="https:\/\/sylobot\.com"[^>]*>Powered by Sylo<\/a>/;

  const plain = await (await get(`/quotes/${GID}`)).text();
  assert.doesNotMatch(plain, /\/look\//, 'a server with no look gets plain Sylo');
  assert.doesNotMatch(plain, /has-look/);
  assert.match(plain, link);

  await json(await putFile(upload(await pic(200, 100))));
  const v = await json(await save({ accent: '#5865f2', background: 'upload' }));

  const quotes = await (await get(`/quotes/${GID}`)).text();
  assert.ok(quotes.includes(`<link rel="stylesheet" href="${v.effective.css}" />`), 'the style sheet');
  assert.match(quotes, /<body class="has-look has-look-image">/);
  assert.ok(quotes.indexOf('/public.css') < quotes.indexOf(v.effective.css), "after Sylo's own styles");
  assert.match(quotes, link);
  assert.doesNotMatch(quotes, /<style|style=/, 'no inline style: the CSP stays strict');

  // The appeal page, with a valid link, in the same look.
  const appeal = await (
    await get(`/appeal/${GID}?t=${encodeURIComponent(signAppealToken(GID, USER))}`)
  ).text();
  assert.ok(appeal.includes(v.effective.css));
  assert.match(appeal, /<body class="has-look has-look-image">/);
  assert.match(appeal, /Appeal your ban/);
  assert.match(appeal, link);

  // An invalid link does not show whose page it was: plain Sylo, but the link is still there.
  const invalid = await (await get(`/appeal/${GID}?t=nonsense`)).text();
  assert.doesNotMatch(invalid, /\/look\//);
  assert.match(invalid, link);

  // An accent without a picture: the class without the image.
  await save({ accent: '#5865f2', background: 'none' });
  const accentOnly = await (await get(`/quotes/${GID}`)).text();
  assert.match(accentOnly, /<body class="has-look">/);
  assert.match(accentOnly, link);
});

test('the dashboard member pages (application form, web shop) get the look in their data', async () => {
  assert.equal(await lookRef(GID), null);
  await save({ accent: '#5865f2', background: 'none' });
  const ref = await lookRef(GID);
  assert.match(ref.css, new RegExp(`^/look/${GID}\\.[0-9a-f]{16}\\.css$`));
  assert.equal(ref.image, false);
  await putFile(upload(await pic(50, 50)));
  await save({ accent: '#5865f2', background: 'upload' });
  assert.equal((await lookRef(GID)).image, true);
});

test('purging a server removes its look and both pictures', async () => {
  await putFile(upload(await pic(50, 50)));
  await putLookImage(GID, 'splash', {
    hash: '0123456789abcdef',
    mime: 'image/webp',
    data: await pic(10, 10, 'webp'),
    origin: 'o',
  });
  await setPublicLook(GID, { accent: '#5865f2', background: 'upload' });
  assert.equal(rows().length, 2);
  await purgeGuild(GID);
  assert.equal(rows().length, 0);
  assert.deepEqual(await getPublicLook(GID), { accent: '', background: 'none', updatedAt: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guild_public_look WHERE guild_id = ?').get(GID).n, 0);
});

test('a forced check that lands while an unforced one is running is not answered by it', async () => {
  cdnBody = await pic(100, 100, 'webp');
  app.guild.splash = 'f1';
  cdnStatus = 500;
  assert.equal((await refreshSplash(app.guild, { force: true })).status, 'failed'); // starts the retry gate
  cdnStatus = 200;
  // The page view's check stops at the gate; the save's (forced) check, started right behind it, must still run.
  const unforced = refreshSplash(app.guild);
  const forced = refreshSplash(app.guild, { force: true });
  assert.equal((await unforced).status, 'failed');
  assert.equal((await forced).status, 'updated');
  assert.equal(cdnHits, 2, 'one failed download and one that worked');
  assert.ok(await getLookImageMeta(GID, 'splash'));
});

test('the style sheet is kept for a year (its address is its content), the picture for a day', async () => {
  const up = await json(await putFile(upload(await pic(40, 40))));
  const v = await json(await save({ accent: '#5865f2', background: 'upload' }));
  assert.equal(
    (await get(v.effective.css)).headers.get('cache-control'),
    'public, max-age=31536000, immutable'
  );
  assert.equal((await get(up.upload.url)).headers.get('cache-control'), 'public, max-age=86400');
});

test('the leaderboards take the look too, and end with the Powered by Sylo link', async () => {
  await setGuildModule(GID, 'leveling', { enabled: true, config: { publicLeaderboard: true } });
  await setGuildModule(GID, 'economy', { enabled: true, config: { publicLeaderboard: true } });
  const link = /<a href="https:\/\/sylobot\.com"[^>]*>Powered by Sylo<\/a>/;
  for (const path of [`/leaderboard/${GID}`, `/economy/${GID}`]) {
    const plain = await get(path);
    assert.equal(plain.status, 200, path);
    const plainHtml = await plain.text();
    assert.doesNotMatch(plainHtml, /has-look|\/look\//, path);
    assert.match(plainHtml, link);
  }
  await json(await putFile(upload(await pic(200, 100))));
  const v = await json(await save({ accent: '#5865f2', background: 'upload' }));
  for (const path of [`/leaderboard/${GID}`, `/economy/${GID}`]) {
    const html = await (await get(path)).text();
    assert.ok(html.includes(`<link rel="stylesheet" href="${v.effective.css}" />`), path);
    assert.match(html, /<body class="has-look has-look-image">/, path);
    assert.match(html, link, path);
  }
});

test('the "Powered by Sylo" line is the same muted frame link on every page, whatever the accent', async () => {
  await setGuildModule(GID, 'quote-board', { enabled: true, config: { publicPage: true } });
  await save({ accent: '#ff0000', background: 'none' });
  const html = await (await get(`/quotes/${GID}`)).text();
  assert.match(
    html,
    /<p class="lb-foot muted small"><a href="https:\/\/sylobot\.com" rel="noopener noreferrer">Powered by Sylo<\/a><\/p>/
  );
  const css = await (await get('/public.css')).text();
  assert.match(css, /body \.lb-foot a,\s*body \.auth-foot a \{\s*color: var\(--text-muted\);/);
});

test('saving the invite background keeps the retry gate and the check limit, so a save loop cannot start downloads', async () => {
  cdnBody = await pic(100, 100, 'webp');
  app.guild.splash = 'loop';
  cdnStatus = 500;
  const statuses = [];
  for (let i = 0; i < 9; i++)
    statuses.push((await save({ accent: '', background: 'discord-splash' })).status);
  // The first save tried a download and failed; the saves right behind it stopped at the 15-minute gate
  // (no new download), and past six a minute the limit answers before anything runs.
  assert.equal(statuses[0], 502);
  assert.equal(cdnHits, 1, `one download, not one per save: ${statuses}`);
  assert.ok(statuses.includes(429), `the limit answers a save loop: ${statuses}`);
  assert.equal((await getPublicLook(GID)).background, 'none');
  // A save that does not touch the splash is not counted against that limit.
  assert.equal((await save({ accent: '#5865f2', background: 'none' })).status, 200);
});

test('a stored picture is always served as image/webp, whatever its mime column says', async () => {
  await putLookImage(GID, 'splash', {
    hash: '0123456789abcdef',
    mime: 'text/html',
    data: await pic(10, 10, 'webp'),
    origin: 'o',
  });
  const res = await get(`/look/${GID}.0123456789abcdef.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
