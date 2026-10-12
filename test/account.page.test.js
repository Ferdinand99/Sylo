// The /account page: connecting and disconnecting platforms. See helpers/oauthApp.js for the harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  browser,
  guildIds,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');

// --- the account page --------------------------------------------------------------

const csrfIn = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const postForm = (b, path, fields) =>
  b.get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

test('the account page asks you to sign in first', async () => {
  const res = await browser().get('/account');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login');
});

test('the account page offers to connect the platform you have not linked, and the sidebar links to it', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const page = await (await b.get('/account')).text();
  assert.match(page, /Connected as <strong>ferdi<\/strong>/);
  assert.match(page, /href="\/auth\/connect\/fluxer"[^>]*hx-boost="false"/);
  assert.doesNotMatch(page, /href="\/auth\/connect\/discord"/);
  const home = await (await b.get('/guilds')).text().catch(() => '');
  void home;
  const sidebar = await (await b.get('/roadmap')).text();
  assert.match(sidebar, /<a[^>]*href="\/account"/);
});

test('connecting from the account page returns to it with a confirmation', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const done = await signIn(b, 'fluxer', { connect: true });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/account?msg=connected');
  const page = await (await b.get('/account?msg=connected')).text();
  assert.match(page, /Account connected/);
  assert.match(page, /Connected as <strong>Ferdinand99<\/strong>/);
});

test('an identity can be disconnected, but not the last one', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const page = await (await b.get('/account')).text();
  const token = csrfIn(page);
  assert.ok(token, 'the page carries a CSRF token');

  const off = await postForm(b, '/account/disconnect/fluxer', { _csrf: token });
  assert.equal(off.status, 302);
  assert.equal(off.headers.get('location'), '/account?msg=disconnected');
  assert.equal(await findIdentity('fluxer', profiles.fluxer.id), null);
  assert.deepEqual(await guildIds(b), [D_GUILD], 'the Fluxer guilds are gone with the identity');

  // The page no longer offers it, but the server refuses regardless.
  const last = await postForm(b, '/account/disconnect/discord', { _csrf: token });
  assert.equal(last.headers.get('location'), '/account?msg=last');
  assert.ok(await findIdentity('discord', profiles.discord.id), 'the last identity stays');
});

test('disconnecting needs the CSRF token', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const res = await postForm(b, '/account/disconnect/fluxer', {});
  assert.equal(res.status, 403);
  assert.ok(await findIdentity('fluxer', profiles.fluxer.id));
});
