import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { createApp } from '../src/web/server.js';

// A minimal fake guild — just what baseContext / moduleViewLocals / the afk
// config view touch.
const GID = '900000000000000123';
function fakeGuild() {
  const ch = (id, name, pos) => [id, { id, name, type: 0, rawPosition: pos }];
  return {
    id: GID,
    name: 'Test Guild',
    memberCount: 3,
    iconURL: () => null,
    channels: { cache: new Map([ch('111', 'general', 0), ch('222', 'bots', 1)]) },
    roles: {
      cache: new Map([
        [GID, { id: GID, name: '@everyone', managed: false, position: 0 }],
        ['333', { id: '333', name: 'Member', managed: false, position: 1 }],
      ]),
    },
    emojis: { cache: new Map() },
  };
}

let server;
let base;

test.before(async () => {
  runtime.client = { guilds: { cache: new Map([[GID, fakeGuild()]]) } };
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  runtime.client = null;
});

test('GET /m/afk without HX-Request renders the full page', async () => {
  const res = await fetch(`${base}/guilds/${GID}/m/afk`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /id="module-config"/);
  assert.match(html, /class="sidebar"/); // the shell is present
});

test('GET /m/afk with HX-Request returns only the #module-config fragment', async () => {
  const res = await fetch(`${base}/guilds/${GID}/m/afk`, { headers: { 'HX-Request': 'true' } });
  assert.equal(res.status, 200);
  const html = (await res.text()).trim();
  assert.doesNotMatch(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /class="sidebar"/);
  assert.match(html, /^<div id="module-config">/);
  assert.match(html, /name="mentionReply"/); // the afk view rendered inside
});

test('POST /m/afk/config without HX-Request redirects (no-JS fallback)', async () => {
  const res = await fetch(`${base}/guilds/${GID}/m/afk/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'mentionReply=on&setNickname=on',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/m\/afk/);
});

test('POST /m/afk/config with HX-Request returns the fragment + a toast trigger', async () => {
  const res = await fetch(`${base}/guilds/${GID}/m/afk/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'HX-Request': 'true' },
    body: 'mentionReply=on&setNickname=on',
    redirect: 'manual',
  });
  assert.equal(res.status, 200);
  const html = (await res.text()).trim();
  assert.match(html, /^<div id="module-config">/);
  const trigger = res.headers.get('hx-trigger') || '';
  assert.match(trigger, /toast/);
});
