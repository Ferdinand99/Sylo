// The /account page: connecting and disconnecting platforms. See helpers/oauthApp.js for the harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  F_GUILD,
  memberFetches,
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
  const sidebar = await (await b.get('/commands')).text();
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

test('the server switcher tags each server with its platform once the account spans both', async () => {
  setProfiles();
  const solo = browser();
  await signIn(solo, 'discord');
  assert.doesNotMatch(
    await (await solo.get('/commands')).text(),
    /srv-badge/,
    'a single platform needs no badges'
  );

  const both = browser();
  await signIn(both, 'discord');
  await signIn(both, 'fluxer', { connect: true });
  const html = await (await both.get('/commands')).text();
  assert.match(html, /srv-badge srv-badge-fluxer[^>]*>Fluxer</);
  assert.match(html, /srv-badge srv-badge-discord[^>]*>Discord</);
});

// --- the same account, through the V2 API --------------------------------------------

const v2Json = async (b, path, init) => {
  const res = await b.get(path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const v2Csrf = async (b) => (await (await b.get('/api/v2/csrf')).json()).token;

test('GET /api/v2/account describes the connected platforms', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { status, body } = await v2Json(b, '/api/v2/account');
  assert.equal(status, 200);
  const by = Object.fromEntries(body.platforms.map((p) => [p.platform, p]));
  assert.equal(by.discord.connected, true);
  assert.equal(by.discord.username, 'ferdi');
  assert.equal(by.discord.canDisconnect, false, 'the only sign-in');
  assert.equal(by.fluxer.connected, false);
  assert.equal(by.fluxer.connectHref, '/auth/connect/fluxer');
});

test('POST /api/v2/account/disconnect/:platform unlinks with the CSRF header, and refuses the last identity', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const token = await v2Csrf(b);

  const noToken = await v2Json(b, '/api/v2/account/disconnect/fluxer', { method: 'POST' });
  assert.equal(noToken.status, 403);

  const off = await v2Json(b, '/api/v2/account/disconnect/fluxer', {
    method: 'POST',
    headers: { 'x-csrf-token': token },
  });
  assert.equal(off.status, 200);
  assert.equal(await findIdentity('fluxer', profiles.fluxer.id), null);

  const last = await v2Json(b, '/api/v2/account/disconnect/discord', {
    method: 'POST',
    headers: { 'x-csrf-token': token },
  });
  assert.equal(last.status, 409);
  assert.ok(await findIdentity('discord', profiles.discord.id));
});

test('the V2 guild list carries each server platform', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const { body } = await v2Json(b, '/api/v2/guilds');
  assert.deepEqual(
    body.guilds.map((g) => [g.id.startsWith('fluxer:') ? 'fluxer' : 'discord', g.platform]).sort(),
    [
      ['discord', 'discord'],
      ['fluxer', 'fluxer'],
    ]
  );
});

test('the switcher offers to add a server on each platform, and V2 gets the same links', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const html = await (await b.get('/commands')).text();
  assert.match(
    html,
    /href="https:\/\/discord\.com\/oauth2\/authorize\?[^"]*client_id=123456789012345678[^"]*"[^>]*>[\s\S]*?Add a server on Discord/
  );
  assert.match(
    html,
    /href="http:\/\/fluxer\.test\/oauth2\/authorize\?[^"]*client_id=223456789012345678[^"]*"[^>]*>[\s\S]*?Add a server on Fluxer/
  );

  const { body } = await v2Json(b, '/api/v2/invites');
  assert.deepEqual(
    body.invites.map((i) => i.platform),
    ['discord', 'fluxer']
  );
});

test('ticket pages: an account with no identity on the guild platform is denied without a member lookup', async () => {
  const { setGuildModule } = await import('../src/db/modules.js');
  const { ticketAccessState } = await import('../src/web/middleware/ticketAccess.js');
  await setGuildModule(`fluxer:${F_GUILD}`, 'tickets', {
    enabled: true,
    config: { staffRoles: ['888888888888888888'] },
  });
  // A Discord-only account: nothing to look up on Fluxer.
  const req = {
    account: {
      id: 1,
      identities: [{ platform: 'discord', platformUserId: '333333333333333333', guildIds: [] }],
    },
    params: { guildId: `fluxer:${F_GUILD}` },
  };
  memberFetches.length = 0;
  assert.equal(await ticketAccessState(req), 'denied');
  assert.deepEqual(memberFetches, [], 'no members.fetch(null), which would page through every member');
});
