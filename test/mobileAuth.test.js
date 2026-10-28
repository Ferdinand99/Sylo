// The Sylo app talks to /api with `Authorization: Bearer sylo_…` instead of a session cookie
// (internal/mobile-api-plan.md, task 2): same account and the same rights as the web dashboard,
// no CSRF token, JSON 401/403 instead of login redirects and HTML error pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken, revokeApiTokenValue } = await import('../src/db/apiTokens.js');

const DAY = 24 * 60 * 60 * 1000;

/** Sign in through the web once (that creates the account) and issue an app token for it. */
async function tokenFor(profile) {
  if (profile) profiles.discord = profile;
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'test iPhone', ttlMs: DAY });
  return token;
}

const OWNER = { id: '111111111111111111', username: 'owner', guilds: [{ id: D_GUILD, owner: true }] };
const ownerToken = await tokenFor(OWNER);
setProfiles(); // an admin of D_GUILD who is not a Sylo operator; no rights in OTHER_D_GUILD
const adminToken = await tokenFor();

// App requests are checked live through the bot (test/mobileAccess.test.js): both people are
// members of D_GUILD with Manage Server.
const { runtime } = await import('../src/runtime.js');
const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
for (const id of [OWNER.id, profiles.discord.id]) {
  dGuild.members.cache.set(id, {
    id,
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { cache: { hasAny: () => false } },
  });
}

const app = browser(); // no cookies are ever set for it in these tests
const call = (path, token, init = {}) =>
  app.get(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

test('a valid token reads the API as its account', async () => {
  const res = await call('/api/v2/guilds', adminToken);
  assert.equal(res.status, 200);
  const ids = (await res.json()).guilds.map((g) => g.id);
  assert.ok(ids.includes(D_GUILD));
  assert.ok(!ids.includes(OTHER_D_GUILD));
  assert.equal(res.headers.getSetCookie().length, 0, 'a token request gets no session cookie');
});

test('an unknown, malformed or revoked token is a JSON 401, not a login redirect', async () => {
  for (const bad of ['sylo_nope', 'garbage', '']) {
    const res = await call('/api/v2/guilds', null, { headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.status, 401, `"${bad}"`);
    assert.match(res.headers.get('content-type'), /json/);
  }
  const t = await tokenFor();
  await revokeApiTokenValue(t);
  assert.equal((await call('/api/v2/guilds', t)).status, 401);
});

test('a state-changing request with a token needs no CSRF token', async () => {
  const res = await call(`/api/v2/guilds/${D_GUILD}/modules/afk`, adminToken, {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  // A cookie session still needs its CSRF token, as before.
  const b = browser();
  await signIn(b, 'discord');
  const cookieOnly = await b.get(`/api/v2/guilds/${D_GUILD}/modules/afk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(cookieOnly.status, 403);
});

test('a server the account does not administer is a JSON 403', async () => {
  const res = await call(`/api/v2/guilds/${OTHER_D_GUILD}/overview`, adminToken);
  assert.equal(res.status, 403);
  assert.match(res.headers.get('content-type'), /json/);
});

test('owner-only modules: the operator token gets in, an admin token does not', async () => {
  const path = `/api/v2/guilds/${D_GUILD}/modules/apple-connect/config`;
  assert.equal((await call(path, ownerToken)).status, 200);
  const no = await call(path, adminToken);
  assert.equal(no.status, 403);
  assert.match(no.headers.get('content-type'), /json/);
});

test('a token only works on the API, not on the HTML dashboard', async () => {
  const res = await call(`/v2/guilds/${D_GUILD}/m/afk`, ownerToken, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 302, 'treated as not signed in');
  assert.match(res.headers.get('location'), /\/auth\//);
});
