// Old dashboard addresses open the matching page in the dashboard (/v2) with a permanent redirect,
// for every GET and HEAD whatever its Accept header says (curl -L, link unfurlers, bots). A POST
// gets the 404 an unknown address gets. /health is the one exception: monitors read its JSON, so
// only a request that names text/html moves.
import { D_GUILD, F_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2Build } from '../src/web/routes/v2Client.js';
import { MODULES } from '../src/modules/registry.js';
import { CLASSIC_REDIRECTS, v2PathFor } from '../src/web/middleware/classicRedirect.js';

await startOAuthApp();

let built = true;
v2Build.exists = () => built;

const html = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
const location = (res) => res.headers.get('location');
const toV2 = (res) => res.status === 301 && location(res)?.startsWith('/v2');

const FLUXER = `fluxer:${F_GUILD}`;

// [classic address, address in the new dashboard]
const TABLE = [
  ['/guilds', '/v2'],
  ['/guilds/', '/v2'],
  ['/account', '/v2/account'],
  ['/settings', '/v2/settings'],
  ['/health', '/v2/health'],
  ['/stats', '/v2/stats'],
  ['/commands', '/v2/commands'],
  ['/roadmap', '/v2/roadmap'],
  ['/roadmap/admin', '/v2/roadmap/admin'],
  // A backup download is a link on the Health page.
  ['/health/backups/sylo-manual-2026-10-29.db', '/v2/health'],
  [`/guilds/${D_GUILD}`, `/v2/guilds/${D_GUILD}`],
  [`/guilds/${D_GUILD}/overview`, `/v2/guilds/${D_GUILD}`],
  [`/guilds/${D_GUILD}/settings`, `/v2/guilds/${D_GUILD}/settings`],
  [`/guilds/${D_GUILD}/general`, `/v2/guilds/${D_GUILD}/settings`],
  // The configuration export is a button on the settings page.
  [`/guilds/${D_GUILD}/export`, `/v2/guilds/${D_GUILD}/settings`],
  [`/guilds/${D_GUILD}/member-data`, `/v2/guilds/${D_GUILD}/member-data`],
  [`/guilds/${D_GUILD}/commands`, `/v2/guilds/${D_GUILD}/moderation/commands`],
  [`/guilds/${D_GUILD}/moderation`, `/v2/guilds/${D_GUILD}/moderation`],
  // Unbanning is on the Infractions tab.
  [`/guilds/${D_GUILD}/unban`, `/v2/guilds/${D_GUILD}/moderation/infractions`],
  [`/guilds/${D_GUILD}/appeals`, `/v2/guilds/${D_GUILD}/appeals`],
  [`/guilds/${D_GUILD}/leaderboard`, `/v2/guilds/${D_GUILD}/leaderboard`],
  [`/guilds/${D_GUILD}/insights`, `/v2/guilds/${D_GUILD}/insights`],
  [`/guilds/${D_GUILD}/audit`, `/v2/guilds/${D_GUILD}/audit`],
  [`/guilds/${D_GUILD}/tickets`, `/v2/guilds/${D_GUILD}/tickets`],
  [`/guilds/${D_GUILD}/tickets/42`, `/v2/guilds/${D_GUILD}/tickets/42`],
  // The transcript download is a button on the ticket's page.
  [`/guilds/${D_GUILD}/tickets/42/transcript`, `/v2/guilds/${D_GUILD}/tickets/42`],
  [`/guilds/${D_GUILD}/messages`, `/v2/guilds/${D_GUILD}/messages`],
  [`/guilds/${D_GUILD}/messages/new`, `/v2/guilds/${D_GUILD}/messages/new`],
  [`/guilds/${D_GUILD}/messages/7`, `/v2/guilds/${D_GUILD}/messages/7`],
  [`/guilds/${D_GUILD}/m/welcome`, `/v2/guilds/${D_GUILD}/m/welcome`],
  [`/guilds/${D_GUILD}/m/custom-commands`, `/v2/guilds/${D_GUILD}/m/custom-commands`],
  [`/guilds/${D_GUILD}/m/automod`, `/v2/guilds/${D_GUILD}/m/automod`],
  // The editors inside a module's page are part of its V2 page.
  [`/guilds/${D_GUILD}/m/reminders/r/new`, `/v2/guilds/${D_GUILD}/m/reminders`],
  [`/guilds/${D_GUILD}/m/roles/rr/12`, `/v2/guilds/${D_GUILD}/m/roles`],
  [`/guilds/${D_GUILD}/m/starboard/sb/3`, `/v2/guilds/${D_GUILD}/m/starboard`],
  [`/guilds/${D_GUILD}/m/github/w/new`, `/v2/guilds/${D_GUILD}/m/github`],
  // Case and a trailing slash do not matter to the classic routes either.
  [`/Guilds/${D_GUILD}/Tickets/42/`, `/v2/guilds/${D_GUILD}/tickets/42`],
  // Fluxer keys: the colon, plain or as %3A.
  [`/guilds/${FLUXER}/tickets/9`, `/v2/guilds/${FLUXER}/tickets/9`],
  [`/guilds/fluxer%3A${F_GUILD}/tickets/9`, `/v2/guilds/${FLUXER}/tickets/9`],
  [`/guilds/fluxer%3a${F_GUILD}/appeals`, `/v2/guilds/${FLUXER}/appeals`],
  [`/guilds/${FLUXER}/m/reminders/r/5`, `/v2/guilds/${FLUXER}/m/reminders`],
  [`/guilds/${FLUXER}`, `/v2/guilds/${FLUXER}`],
];

test('each classic page address opens the matching page in the new dashboard', async () => {
  const b = browser();
  for (const [from, to] of TABLE) {
    const res = await b.get(from, { headers: html });
    assert.equal(res.status, 301, from);
    assert.equal(location(res), to, from);
  }
});

test('the table above covers every row of CLASSIC_REDIRECTS', () => {
  for (const { from, pattern } of CLASSIC_REDIRECTS) {
    assert.ok(
      TABLE.some(([path]) => pattern.test(decodeURIComponent(path))),
      `no test row for ${from}`
    );
  }
});

test('the redirect works before sign-in, then the login brings the person to the new page', async () => {
  const b = browser();
  const res = await b.get(`/guilds/${D_GUILD}/tickets/5`, { headers: html });
  assert.equal(location(res), `/v2/guilds/${D_GUILD}/tickets/5`);
  const next = await b.get(location(res), { headers: html });
  assert.equal(next.status, 302);
  assert.match(location(next), /^\/auth\//);
});

test('every target in the mapping table is a real route of the new dashboard', () => {
  const app = readFileSync(new URL('../web-v2/src/App.jsx', import.meta.url), 'utf8');
  const routes = [...app.matchAll(/<Route[^>]*\bpath="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(routes.length > 20, 'found the routes in App.jsx');
  const matches = (path) =>
    routes.some((route) =>
      new RegExp(`^/${route.replace(/\/:\w+\?/g, '(?:/[^/]+)?').replace(/:\w+/g, '[^/]+')}/?$`).test(path)
    );
  for (const [, to] of TABLE) {
    const path = to.replace(/^\/v2/, '');
    if (path === '') continue; // /v2 itself: the dashboard home
    assert.ok(matches(path), `${to} is a route in App.jsx`);
  }
  assert.equal(v2PathFor('/guilds/not-a-key'), null);
});

test('the moderation tabs and module pages the table points at exist in the dashboard', () => {
  const hub = readFileSync(new URL('../web-v2/src/pages/ModerationHub.jsx', import.meta.url), 'utf8');
  const tabs = [...hub.matchAll(/^\s*\['(\w+)', '[^']+', (?:null|'[\w-]+')\],?$/gm)].map((m) => m[1]);
  assert.ok(
    tabs.includes('infractions') && tabs.includes('commands'),
    `found the TABS in ModerationHub: ${tabs}`
  );
  const ids = new Set(MODULES.map((m) => m.id));
  for (const [, to] of TABLE) {
    const tab = /\/moderation\/(\w+)$/.exec(to)?.[1];
    if (tab) assert.ok(tabs.includes(tab), `${to}: no such moderation tab`);
    const module = /\/m\/([\w-]+)$/.exec(to)?.[1];
    if (module) assert.ok(ids.has(module), `${to}: no such module`);
  }
});

test('member data keeps ?user=, and drops the classic page flash messages', async () => {
  const b = browser();
  const res = await b.get(`/guilds/${D_GUILD}/member-data?user=123456789012345678&msg=saved`, {
    headers: html,
  });
  assert.equal(location(res), `/v2/guilds/${D_GUILD}/member-data?user=123456789012345678`);
});

test('addresses with no page of their own are not redirected', async () => {
  const b = browser();
  for (const path of [
    `/guilds/${D_GUILD}/tickets/5/messages.json`,
    `/guilds/${D_GUILD}/m/welcome/card-preview`,
    `/guilds/${D_GUILD}/emojis`,
    '/health/backups/../x',
    '/leaderboard/anything',
    '/auth/login',
    // Not a server key.
    '/guilds/12345/tickets',
  ]) {
    assert.ok(!toV2(await b.get(path, { headers: html })), path);
  }
});

test('every GET and HEAD moves, whatever the Accept header says; a POST gets a 404', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const path = `/guilds/${D_GUILD}/settings`;
  const target = `/v2/guilds/${D_GUILD}/settings`;
  const headers = [
    html,
    { accept: 'application/json' },
    { accept: 'application/json, text/html;q=0.5' },
    { accept: '*/*' },
    { ...html, authorization: 'Bearer not-a-token' },
    {},
  ];
  for (const h of headers) {
    for (const method of ['GET', 'HEAD']) {
      const res = await b.get(path, { method, headers: h });
      assert.equal(res.status, 301, `${method} ${JSON.stringify(h)}`);
      assert.equal(location(res), target);
    }
  }
  const { token } = await (await b.get('/api/v2/csrf')).json();
  const post = await b.get(path, { method: 'POST', headers: { ...html, 'x-csrf-token': token }, body: '' });
  assert.equal(post.status, 404);
});

test('a signed-out curl -L of the public /roadmap link reaches the dashboard board', async () => {
  const res = await browser().get('/roadmap', { headers: { accept: '*/*' } });
  assert.equal(res.status, 301);
  assert.equal(location(res), '/v2/roadmap');
});

test('/health: the JSON for monitors is unchanged, the HTML page moves', async () => {
  const b = browser();
  for (const headers of [{ accept: 'application/json' }, { accept: '*/*' }, {}]) {
    const res = await b.get('/health', { headers });
    assert.equal(res.status, 200, JSON.stringify(headers));
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok(body.discord && body.platforms);
  }
  const page = await b.get('/health', { headers: html });
  assert.equal(location(page), '/v2/health');
});

test('?classic=1 does nothing any more: it goes to /v2 and the redirects stay on', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const home = await b.get('/?classic=1', { headers: html });
  assert.equal(location(home), '/v2');
  assert.ok(toV2(await b.get(`/guilds/${D_GUILD}/settings`, { headers: html })));
});

test('the redirects do not depend on the dashboard being built', async () => {
  built = false;
  try {
    assert.ok(toV2(await browser().get(`/guilds/${D_GUILD}/settings`, { headers: html })));
    assert.ok(toV2(await browser().get('/health', { headers: html })));
  } finally {
    built = true;
  }
});

test('a browser behind HTTP basic auth, or a client with an Authorization header, still moves', async () => {
  const b = browser();
  const path = `/guilds/${D_GUILD}/settings`;
  const basic = { ...html, authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` };
  assert.ok(toV2(await b.get(path, { headers: basic })), 'basic auth is a person');
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const res = await b.get(path, { headers: { ...html, authorization: `${scheme} not-a-token` } });
    assert.ok(toV2(res), scheme);
  }
});

test('/health keeps answering JSON to a bearer-token or catch-all caller', async () => {
  const b = browser();
  const res = await b.get('/health', { headers: { accept: '*/*', authorization: 'Bearer not-a-token' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application[/]json/);
});
