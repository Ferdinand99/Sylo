// The htmx / hx-boost fragment contract on the module-config routes, plus the
// Member-data data-subject flow. Broader route coverage lives in
// test/routes.guilds.test.js and test/routes.misc.test.js; all three share the
// harness in test/helpers/webApp.js.
import { startWebApp, post } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (p, headers) => fetch(app.base + p, { headers, redirect: 'manual' });

test('GET /m/afk without HX-Request renders the full page', async () => {
  const res = await get(`/guilds/${GID}/m/afk`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /id="module-config"/);
  assert.match(html, /class="sidebar"/);
});

test('GET /m/afk with HX-Request returns only the #module-config fragment', async () => {
  const res = await get(`/guilds/${GID}/m/afk`, { 'HX-Request': 'true' });
  assert.equal(res.status, 200);
  const html = (await res.text()).trim();
  assert.doesNotMatch(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /class="sidebar"/);
  assert.match(html, /^<div id="module-config">/);
  assert.match(html, /name="mentionReply"/);
});

test('GET /m/afk with an hx-boost navigation returns the full page', async () => {
  const res = await get(`/guilds/${GID}/m/afk`, { 'HX-Request': 'true', 'HX-Boosted': 'true' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /id="module-config"/);
});

test('POST /m/afk/config without HX-Request redirects (no-JS fallback)', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/afk/config`, 'mentionReply=on&setNickname=on');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/m\/afk/);
});

test('POST /m/afk/config with HX-Request returns the fragment + a toast trigger', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/afk/config`, 'mentionReply=on&setNickname=on', {
    'HX-Request': 'true',
  });
  assert.equal(res.status, 200);
  assert.match((await res.text()).trim(), /^<div id="module-config">/);
  assert.match(res.headers.get('hx-trigger') || '', /toast/);
});

// --- Member data (data-subject requests) --------------------------------

const MEMBER = '900000000000009999';

test('GET /member-data with a user id renders the lookup + data table', async () => {
  const { db } = await import('../src/db/index.js');
  db.prepare(
    'INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?,?,?,?,?)'
  ).run(GID, MEMBER, 'mod', 'test', Date.now());

  const res = await get(`/guilds/${GID}/member-data?user=${MEMBER}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Member data/);
  assert.match(html, new RegExp(MEMBER));
  assert.match(html, /Warnings/);
});

test('POST /member-data/forget deletes the data, DMs the member, and redirects', async () => {
  const { db } = await import('../src/db/index.js');
  assert.ok(
    db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?').get(GID, MEMBER).n >=
      1
  );
  app.sink.dms.length = 0;

  const res = await post(
    app.base,
    `/guilds/${GID}/member-data/forget`,
    `userId=${MEMBER}&confirm=on&reason=at+their+request`
  );
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=forgot/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?').get(GID, MEMBER).n,
    0
  );
  assert.equal(app.sink.dms.length, 1);
  assert.equal(app.sink.dms[0].id, MEMBER);
});

test('POST /member-data/forget without the confirm box does nothing', async () => {
  const res = await post(app.base, `/guilds/${GID}/member-data/forget`, `userId=${MEMBER}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=noconfirm/);
});
