// The account: connecting and disconnecting platforms, through the sign-in flow and /api/v2/account.
// See helpers/oauthApp.js for the harness.
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

const v2Json = async (b, path, init) => {
  const res = await b.get(path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const v2Csrf = async (b) => (await (await b.get('/api/v2/csrf')).json()).token;

// --- connecting a platform ----------------------------------------------------------

test('the account API asks you to sign in first', async () => {
  const res = await browser().get('/api/v2/account');
  assert.equal(res.status, 401);
});

test('connecting from the account page returns to it', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const done = await signIn(b, 'fluxer', { connect: true });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/v2/account');
  const { body } = await v2Json(b, '/api/v2/account');
  const by = Object.fromEntries(body.platforms.map((p) => [p.platform, p]));
  assert.equal(by.fluxer.connected, true);
  assert.equal(by.fluxer.username, 'Ferdinand99');
});

// --- the same account, through the V2 API --------------------------------------------

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
  assert.deepEqual(await guildIds(b), [D_GUILD], 'the Fluxer guilds are gone with the identity');

  const last = await v2Json(b, '/api/v2/account/disconnect/discord', {
    method: 'POST',
    headers: { 'x-csrf-token': token },
  });
  assert.equal(last.status, 409);
  assert.ok(await findIdentity('discord', profiles.discord.id));
});

test('a POST whose only CSRF proof is a _csrf body field is refused', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const token = await v2Csrf(b);
  for (const [type, body] of [
    ['application/x-www-form-urlencoded', new URLSearchParams({ _csrf: token }).toString()],
    ['application/json', JSON.stringify({ _csrf: token })],
  ]) {
    const res = await b.get('/api/v2/account/disconnect/fluxer', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
    assert.equal(res.status, 403, type);
  }
  assert.ok(await findIdentity('fluxer', profiles.fluxer.id), 'nothing was disconnected');
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

test('V2 offers to add a server on each platform', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
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
