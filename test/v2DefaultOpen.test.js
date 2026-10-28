// Open mode (no login configured, a synthetic "local admin"): the new dashboard is the default
// there too, and its API lists servers and saves settings. The only way back to the classic
// dashboard is /?classic=1, remembered in a cookie because open mode has no session.
import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Build } from '../src/web/routes/v2Client.js';

let app;
let built = true;
test.before(async () => {
  app = await startWebApp();
  v2Build.exists = () => built;
});
test.after(() => app.close());

const html = { accept: 'text/html' };
const json = { accept: 'application/json', 'content-type': 'application/json' };

// A browser with a cookie jar that does not follow redirects.
function openBrowser() {
  const jar = new Map();
  return async (path, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(app.base + path, {
      redirect: 'manual',
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (/expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  };
}

test('open mode: GET / goes to /v2', async () => {
  const res = await openBrowser()('/', { headers: html });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/v2');
});

test('open mode: the saved dashboard preference does not matter', async () => {
  const set = await fetch(`${app.base}/api/v2/prefs`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ dashboardVersion: 'v1' }),
  });
  assert.equal(set.status, 200);
  const res = await openBrowser()('/', { headers: html });
  assert.equal(res.headers.get('location'), '/v2');
});

test('open mode: old addresses open the new dashboard', async () => {
  const get = openBrowser();
  const res = await get(`/guilds/${GID}/tickets/3`, { headers: html });
  assert.equal(res.headers.get('location'), `/v2/guilds/${GID}/tickets/3`);
  assert.equal((await get('/account', { headers: html })).headers.get('location'), '/v2/account');
});

test('open mode: /?classic=1 stays classic until /v2 is opened again', async () => {
  const get = openBrowser();
  const classic = await get('/?classic=1', { headers: html });
  assert.match(classic.headers.get('location'), /^\/guilds\/.+\/overview$/);
  const home = await get('/', { headers: html });
  assert.match(home.headers.get('location'), /^\/guilds\/.+\/overview$/, 'a later visit stays classic');
  const page = await get(`/guilds/${GID}/settings`, { headers: html });
  assert.equal(page.status, 200, 'a classic page is served, not redirected');
  assert.match(await page.text(), /Sylo 5\.0/, 'with the retirement banner');
  await get('/v2/', { headers: html });
  assert.equal((await get('/', { headers: html })).headers.get('location'), '/v2');
});

test('open mode: without a V2 build / is the classic dashboard', async () => {
  built = false;
  try {
    const res = await openBrowser()('/', { headers: html });
    assert.match(res.headers.get('location'), /^\/guilds\/.+\/overview$/);
  } finally {
    built = true;
  }
});

test('open mode: the new dashboard API lists the servers and saves a module config', async () => {
  const guilds = await (await fetch(`${app.base}/api/v2/guilds`, { headers: json })).json();
  assert.ok(
    guilds.guilds.some((g) => g.id === GID),
    'the server is listed'
  );

  const url = `${app.base}/api/v2/guilds/${GID}/modules/afk/config`;
  const save = await fetch(url, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ setNickname: false, mentionReply: true, ignoreChannels: [] }),
  });
  assert.equal(save.status, 200);
  const read = await (await fetch(url, { headers: json })).json();
  assert.equal(read.config.setNickname, false);
  assert.equal(read.config.mentionReply, true);

  const toggle = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/afk`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(toggle.status, 200);
});

test("open mode: the overview's links point into the new dashboard", async () => {
  const body = await (await fetch(`${app.base}/api/v2/guilds/${GID}/overview`, { headers: json })).json();
  const cards = body.groups.flatMap((g) => g.cards);
  assert.ok(cards.length > 10);
  for (const card of cards) {
    assert.ok(card.href.startsWith(`/v2/guilds/${GID}/`), `${card.id} -> ${card.href}`);
  }
  const href = Object.fromEntries(cards.map((c) => [c.id, c.href]));
  assert.equal(href.general, `/v2/guilds/${GID}/settings`);
  assert.equal(href.commands, `/v2/guilds/${GID}/moderation/commands`);
  assert.equal(href.messages, `/v2/guilds/${GID}/messages`);
  assert.equal(href.insights, `/v2/guilds/${GID}/insights`);
  assert.equal(href.welcome, `/v2/guilds/${GID}/m/welcome`);
});
