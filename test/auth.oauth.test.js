// The whole login path through the real Express app: OAuth round-trips for Discord and
// Fluxer (their HTTP endpoints stubbed), accounts, linking, sessions, access rules.
process.env.DISCORD_TOKEN = 'dtoken.test';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.DISCORD_CLIENT_SECRET = 'discord-secret';
process.env.FLUXER_TOKEN = 'ftoken.test';
process.env.FLUXER_CLIENT_ID = '223456789012345678';
process.env.FLUXER_CLIENT_SECRET = 'fluxer-secret';
process.env.FLUXER_WEB_URL = 'http://fluxer.test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.OWNER_IDS = '111111111111111111';
process.env.FLUXER_OWNER_IDS = '555555555555555555';
delete process.env.DASHBOARD_URL;

import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 100 }));

const { runtime } = await import('../src/runtime.js');
const { createApp } = await import('../src/web/server.js');
const { findIdentity, identitiesOf } = await import('../src/db/accounts.js');

const D_GUILD = '900000000000000201';
const F_GUILD = '900000000000000202';
const OTHER_D_GUILD = '900000000000000203';

// What each platform's API says about whoever is logging in next.
const profiles = {
  discord: {
    id: '111111111111111111',
    username: 'ferdi',
    guilds: [
      { id: D_GUILD, owner: true },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  },
  fluxer: { id: '555555555555555555', username: 'Ferdinand99', guilds: [{ id: F_GUILD, owner: true }] },
};

// Stub only the platforms' own endpoints; everything else (the test's requests to the app) is real.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const platform = u.startsWith('https://discord.com/api/v10')
    ? 'discord'
    : u.startsWith('http://fluxer.test/api/v1')
      ? 'fluxer'
      : null;
  if (!platform) return realFetch(url, init);
  const p = profiles[platform];
  if (u.endsWith('/oauth2/token')) return json({ access_token: `${platform}-token` });
  if (u.endsWith('/users/@me/guilds')) return json(p.guilds);
  if (u.endsWith('/users/@me'))
    return json({ id: p.id, username: p.username, global_name: null, avatar: null });
  return json({}, 404);
};

const guild = (id, name, client) => ({
  id,
  name,
  client,
  iconURL: () => null,
  members: { cache: new Map() },
  ownerId: 'x',
});
const base_client = () => ({
  isReady: () => true,
  ws: { ping: 5 },
  user: { displayAvatarURL: () => null },
  commands: new Map(),
});
const discordClient = base_client();
discordClient.guilds = {
  cache: new Map([
    [D_GUILD, guild(D_GUILD, 'D-main', discordClient)],
    [OTHER_D_GUILD, guild(OTHER_D_GUILD, 'D-other', discordClient)],
  ]),
};
const fluxerClient = base_client();
fluxerClient.guilds = { cache: new Map([[F_GUILD, guild(F_GUILD, 'F-main', fluxerClient)]]) };
runtime.clients.discord = discordClient;
runtime.clients.fluxer = fluxerClient;

const server = await new Promise((resolve) => {
  const s = createApp().listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.closeAllConnections?.();
  server.close();
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
  globalThis.fetch = realFetch;
});

/** A browser: remembers cookies between requests, never follows redirects. */
function browser() {
  const jar = new Map();
  const remember = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  };
  const request = async (path, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    });
    remember(res);
    return res;
  };
  return { get: request, jar };
}

// Ids that are nobody's operator id, unique per call: the database is shared across the file.
let seq = 0;
const uid = (prefix) => `${prefix}${String(++seq).padStart(6, '0')}`;
const setProfiles = ({ discordId, fluxerId } = {}) => {
  profiles.discord = {
    id: discordId ?? uid('3333333333'),
    username: 'ferdi',
    guilds: [
      { id: D_GUILD, owner: true },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  };
  profiles.fluxer = {
    id: fluxerId ?? uid('4444444444'),
    username: 'Ferdinand99',
    guilds: [{ id: F_GUILD, owner: true }],
  };
};

const stateOf = (res) => new URL(res.headers.get('location')).searchParams.get('state');

/** Do the whole OAuth round-trip for a platform; returns the callback response. */
async function signIn(b, platform, { connect = false } = {}) {
  const start = await b.get(connect ? `/auth/connect/${platform}` : `/auth/${platform}/login`);
  assert.equal(start.status, 302);
  return b.get(`/auth/${platform}/callback?code=abc&state=${stateOf(start)}`);
}

const guildIds = async (b) => (await (await b.get('/api/v2/guilds')).json()).guilds.map((g) => g.id).sort();

test('an unauthenticated visitor is sent to the chooser when both logins are offered', async () => {
  const res = await browser().get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login');
  const page = await (await browser().get('/auth/login')).text();
  assert.match(page, /Log in with Discord/);
  assert.match(page, /Log in with Fluxer/);
  // The buttons leave for another site; a boosted (fetch-based) navigation would die on CORS
  // with "Network error", so each must opt out of htmx boosting.
  for (const platform of ['discord', 'fluxer']) {
    assert.match(page, new RegExp(`<a[^>]*href="/auth/${platform}/login"[^>]*hx-boost="false"`));
  }
});

test('the login redirect points at each platform with a state and the right client', async () => {
  const b = browser();
  const d = new URL((await b.get('/auth/discord/login')).headers.get('location'));
  assert.equal(d.origin + d.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(d.searchParams.get('client_id'), '123456789012345678');
  assert.equal(d.searchParams.get('scope'), 'identify guilds');
  const f = new URL((await b.get('/auth/fluxer/login')).headers.get('location'));
  assert.equal(f.origin + f.pathname, 'http://fluxer.test/oauth2/authorize');
  assert.equal(f.searchParams.get('client_id'), '223456789012345678');
  assert.match(f.searchParams.get('redirect_uri'), /\/auth\/fluxer\/callback$/);
});

test('Fluxer login: signs in, shows only the Fluxer guilds they administer, and names the account', async () => {
  setProfiles();
  const b = browser();
  const done = await signIn(b, 'fluxer');
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/');
  assert.deepEqual(await guildIds(b), [`fluxer:${F_GUILD}`]);
  const identity = await findIdentity('fluxer', profiles.fluxer.id);
  assert.equal(identity.username, 'Ferdinand99');
  assert.deepEqual(identity.guildIds, [`fluxer:${F_GUILD}`]);
});

test('Discord login: only the guilds they administer, other Discord guilds stay hidden', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.deepEqual(await guildIds(b), [D_GUILD]);
});

test('a wrong or replayed state is refused', async () => {
  const b = browser();
  const start = await b.get('/auth/fluxer/login');
  const bad = await b.get('/auth/fluxer/callback?code=abc&state=not-the-state');
  assert.equal(bad.status, 400);
  // The state is single-use: replaying the real one after a failure no longer works.
  const replay = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(start)}`);
  assert.equal(replay.status, 400);
});

test('a state started for one platform cannot finish the other', async () => {
  const b = browser();
  const start = await b.get('/auth/discord/login');
  const res = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(start)}`);
  assert.equal(res.status, 400);
});

test('connect: a signed-in Discord account gains a Fluxer identity and sees both platforms', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const done = await signIn(b, 'fluxer', { connect: true });
  assert.equal(done.status, 302);
  assert.deepEqual(await guildIds(b), [D_GUILD, `fluxer:${F_GUILD}`].sort());
  const d = await findIdentity('discord', profiles.discord.id);
  const f = await findIdentity('fluxer', profiles.fluxer.id);
  assert.equal(d.accountId, f.accountId);
  assert.equal((await identitiesOf(d.accountId)).length, 2);
});

test('signing in with the Fluxer side of a linked account lands on the same account', async () => {
  setProfiles();
  const first = browser();
  await signIn(first, 'discord');
  await signIn(first, 'fluxer', { connect: true });
  const viaFluxer = browser();
  await signIn(viaFluxer, 'fluxer'); // a fresh browser, signing in with Fluxer only
  assert.deepEqual(await guildIds(viaFluxer), [D_GUILD, `fluxer:${F_GUILD}`].sort());
});

test('connecting an identity that belongs to another account is refused', async () => {
  setProfiles();
  const first = browser();
  await signIn(first, 'fluxer'); // this Fluxer user gets their own account
  const second = browser();
  profiles.discord = { id: uid('3333333333'), username: 'third', guilds: [] };
  await signIn(second, 'discord');
  const res = await signIn(second, 'fluxer', { connect: true });
  assert.equal(res.status, 409);
});

test('logging out ends the session on the server', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.deepEqual(await guildIds(b), [D_GUILD]);
  const cookieBefore = new Map(b.jar);
  await b.get('/auth/logout');
  const replay = browser();
  for (const [k, v] of cookieBefore) replay.jar.set(k, v);
  const res = await replay.get('/api/v2/guilds');
  assert.notEqual(res.status, 200, 'a copied pre-logout cookie no longer works');
});

test('/health is for operators only, and each platform has its own operator list', async () => {
  profiles.discord = { id: '111111111111111111', username: 'ferdi', guilds: [] };
  const operator = browser();
  await signIn(operator, 'discord');
  assert.equal((await operator.get('/health', { headers: { accept: 'text/html' } })).status, 200);

  profiles.discord = { id: uid('3333333333'), username: 'nobody', guilds: [] };
  const other = browser();
  await signIn(other, 'discord');
  assert.equal((await other.get('/health', { headers: { accept: 'text/html' } })).status, 403);

  // A Discord id that equals a Fluxer owner id is not an owner on Discord.
  profiles.discord = { id: '555555555555555555', username: 'lookalike', guilds: [] };
  const lookalike = browser();
  await signIn(lookalike, 'discord');
  assert.equal((await lookalike.get('/health', { headers: { accept: 'text/html' } })).status, 403);
});

test('an expired or garbage session cookie is treated as signed out', async () => {
  const b = browser();
  b.jar.set('sylo.sid', 'garbage');
  const res = await b.get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login');
});
