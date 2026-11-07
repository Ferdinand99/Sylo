// Open mode (no login configured, a synthetic "local admin"): the dashboard (/v2) is the only one,
// its API lists servers and saves settings, and the old addresses move to it.
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
const get = (path, headers = html) => fetch(app.base + path, { redirect: 'manual', headers });

test('open mode: GET / goes to /v2', async () => {
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/v2');
});

test('open mode: ?classic=1 goes to /v2 as well, there is no classic dashboard', async () => {
  const res = await get('/?classic=1');
  assert.equal(res.headers.get('location'), '/v2');
});

test('open mode: old addresses open the dashboard', async () => {
  const res = await get(`/guilds/${GID}/tickets/3`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), `/v2/guilds/${GID}/tickets/3`);
  assert.equal((await get('/account')).headers.get('location'), '/v2/account');
});

test('open mode: without a V2 build /v2 answers a plain-text 503 that says how to build it', async () => {
  built = false;
  try {
    const res = await get('/v2/guilds');
    assert.equal(res.status, 503);
    assert.match(await res.text(), /npm run build:v2/);
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
