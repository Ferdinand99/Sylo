// Boots the real Express app with both logins on and the platforms' OAuth APIs stubbed.
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

import './tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 100 }));

const { runtime } = await import('../../src/runtime.js');
const { createApp } = await import('../../src/web/server.js');

export const D_GUILD = '900000000000000201';
export const F_GUILD = '900000000000000202';
export const OTHER_D_GUILD = '900000000000000203';

// What each platform's API says about whoever is logging in next.
export const profiles = {
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
const stubbedFetch = async (url, init) => {
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

/** Arguments of every guild.members.fetch() call the app made on the fake guilds. */
export const memberFetches = [];

const guild = (id, name, client) => ({
  id,
  name,
  client,
  iconURL: () => null,
  members: {
    cache: new Map(),
    // Every member lookup is recorded; none of them succeeds.
    fetch: async (arg) => {
      memberFetches.push(arg);
      throw new Error('Unknown Member');
    },
  },
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

let base;

/** Start the app on a free port and install the fake platforms. Call once per test file. */
export async function startOAuthApp() {
  runtime.clients.discord = discordClient;
  runtime.clients.fluxer = fluxerClient;
  globalThis.fetch = stubbedFetch;
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  test.after(() => {
    server.closeAllConnections?.();
    server.close();
    runtime.clients.discord = null;
    runtime.clients.fluxer = null;
    globalThis.fetch = realFetch;
  });
}

/** A browser: remembers cookies between requests, never follows redirects. */
export function browser() {
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
export const uid = (prefix) => `${prefix}${String(++seq).padStart(6, '0')}`;
export const setProfiles = ({ discordId, fluxerId } = {}) => {
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

export const stateOf = (res) => new URL(res.headers.get('location')).searchParams.get('state');

/** Do the whole OAuth round-trip for a platform; returns the callback response. */
export async function signIn(b, platform, { connect = false } = {}) {
  const start = await b.get(connect ? `/auth/connect/${platform}` : `/auth/${platform}/login`);
  assert.equal(start.status, 302);
  return b.get(`/auth/${platform}/callback?code=abc&state=${stateOf(start)}`);
}

export const guildIds = async (b) =>
  (await (await b.get('/api/v2/guilds')).json()).guilds.map((g) => g.id).sort();
