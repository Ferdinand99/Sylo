// Who may reach the update notice (src/web/routes/v2Update.js), by kind of caller: an operator's app token
// (no CSRF token needed, by design), a non-operator's app token, people who only have Inbox or View access
// to a server, a Fluxer operator, and open mode (no dashboard login), where "Update now" is refused unless
// WISE_WREN_ALLOW_OPEN_MODE=true. Its own file: the approve route's budget is per account and per process.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';
import { OPERATOR_ID } from './helpers/v2Guarded.js';
import { FAKE_TOKEN, startFakeWren } from './helpers/fakeWren.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { setDashboardAccessRoles } = await import('../src/db/guildSettings.js');
const { setUpdateService } = await import('../src/web/routes/v2Update.js');
const { createUpdateService } = await import('../src/web/lib/updateService.js');
const { createUpdateChecker } = await import('../src/lib/updateCheck.js');
const { createWrenClient } = await import('../src/lib/wiseWren.js');

const wren = await startFakeWren({ targetToken: true });
test.after(() => wren.close());

const RELEASE = {
  tag_name: 'v99.0.0',
  html_url: 'https://github.com/Ferdinand99/Sylo/releases/tag/v99.0.0',
  published_at: '2026-11-20T10:00:00Z',
  body: '',
};

function useService() {
  wren.state.runs.clear();
  wren.requests.length = 0;
  let remembered = null;
  setUpdateService(
    createUpdateService({
      checker: createUpdateChecker({
        version: '5.2.0',
        fetchImpl: async () => new Response(JSON.stringify(RELEASE), { status: 200 }),
      }),
      wren: createWrenClient({ url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId }),
      store: { get: async () => remembered, set: async (run) => void (remembered = run) },
    })
  );
}

const VIEW = '700000000000000511';
const INBOX = '700000000000000512';
const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);

function fakeMember(id, roles) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  cache.some = (fn) => [...cache.values()].some(fn);
  return { id, permissions: { has: () => false }, roles: { highest: { position: 5 }, cache } };
}

let clients = 0;
const json = { accept: 'application/json', 'content-type': 'application/json' };

/**
 * Signs in on `platform` as the account with this id and gives the JSON helpers for the web session
 * (with its CSRF token) and for an app token of the same account (no CSRF token). Each person
 * sends requests from an address of their own.
 */
async function person({ platform = 'discord', id, roles = [], guilds } = {}) {
  setProfiles(platform === 'discord' ? { discordId: id } : { fluxerId: id });
  if (guilds) profiles[platform].guilds = guilds;
  const b = browser();
  const ip = `10.8.${Math.floor(++clients / 250)}.${clients % 250}`;
  const send = (path, init = {}) =>
    b.get(path, { ...init, headers: { ...init.headers, 'x-forwarded-for': ip } });
  await signIn(b, platform);
  const userId = profiles[platform].id;
  if (platform === 'discord') dGuild.members.cache.set(userId, fakeMember(userId, roles));
  const csrf = (await (await send('/api/v2/csrf', { headers: { accept: 'application/json' } })).json()).token;
  const { accountId } = await findIdentity(platform, userId);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  const auth = { authorization: `Bearer ${token}` };
  return {
    web: {
      get: (p) => send(`/api/v2${p}`, { headers: { accept: 'application/json' } }),
      post: (p, body = {}) =>
        send(`/api/v2${p}`, {
          method: 'POST',
          headers: { ...json, 'x-csrf-token': csrf },
          body: JSON.stringify(body),
        }),
    },
    app: {
      get: (p) => send(`/api/v2${p}`, { headers: { ...auth, accept: 'application/json' } }),
      post: (p, body = {}) =>
        send(`/api/v2${p}`, { method: 'POST', headers: { ...json, ...auth }, body: JSON.stringify(body) }),
    },
  };
}

const ROUTES = [
  ['get', '/update'],
  ['get', '/update/wren/runs/12'],
  ['post', '/update/wren/approve'],
];

async function assertRefused(caller, label) {
  for (const [method, path] of ROUTES) {
    for (const [how, client] of [
      ['web', caller.web],
      ['app', caller.app],
    ]) {
      const res = await client[method](path);
      assert.equal(res.status, 403, `${label} ${how} ${method} ${path}`);
      assert.match((await res.json()).error, /operators/);
    }
  }
}

test("an operator's app token reads the notice and updates; a POST needs no CSRF token with a bearer token", async () => {
  useService();
  const op = await person({ id: OPERATOR_ID });
  const read = await op.app.get('/update');
  assert.equal(read.status, 200);
  const status = await read.json();
  assert.equal(status.available, true);
  assert.equal(status.wren.canApprove, true);

  const approve = await op.app.post('/update/wren/approve');
  assert.equal(approve.status, 200);
  const { runId } = await approve.json();
  assert.ok(Number.isSafeInteger(runId));
  assert.equal((await op.app.get(`/update/wren/runs/${runId}`)).status, 200);
});

test('an app token of an account that is not an operator is refused every route, also a POST', async () => {
  useService();
  const admin = await person({
    id: '333333333333330101',
    guilds: [{ id: D_GUILD, owner: true }],
  });
  await assertRefused(admin, 'server admin');
  const nobody = await person({ id: '333333333333330102', guilds: [] });
  await assertRefused(nobody, 'nobody');
  assert.equal(wren.requests.length, 0, 'Wren was not asked for any of them');
});

test('people with only Inbox or View access to a server are not operators', async () => {
  useService();
  await setDashboardAccessRoles(D_GUILD, { inbox: [INBOX], view: [VIEW] });
  const guilds = [
    { id: D_GUILD, owner: false, permissions: '0' },
    { id: OTHER_D_GUILD, owner: false, permissions: '0' },
  ];
  const inbox = await person({ id: '333333333333330103', roles: [INBOX], guilds });
  const view = await person({ id: '333333333333330104', roles: [VIEW], guilds });
  // They do have dashboard access (a sanity check that the roles work), but not to this.
  assert.equal((await inbox.web.get(`/guilds/${D_GUILD}/tickets`)).status, 200);
  assert.equal((await view.web.get(`/guilds/${D_GUILD}/overview`)).status, 200);
  await assertRefused(inbox, 'Inbox');
  await assertRefused(view, 'View');
  assert.equal(wren.requests.length, 0);
  dGuild.members.cache.clear();
});

test('a Fluxer operator (FLUXER_OWNER_IDS) is an operator too', async () => {
  useService();
  const op = await person({ platform: 'fluxer', id: '555555555555555555' });
  assert.equal((await op.web.get('/update')).status, 200);
  assert.equal((await op.app.get('/update')).status, 200);
});

// Config is read once per process, so open mode (no OAuth configured) runs in a child process.
const OPEN_MODE = `
  await import(${JSON.stringify(new URL('./helpers/tmpDb.js', import.meta.url).href)});
  const { createApp } = await import(${JSON.stringify(new URL('../src/web/server.js', import.meta.url).href)});
  const server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = await fetch(base + '/api/v2/update', { headers: { accept: 'application/json' } });
  const status = await get.json();
  const post = await fetch(base + '/api/v2/update/wren/approve', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ getStatus: get.status, status, postStatus: post.status, post: await post.json() }));
  process.exit(0);
`;

async function openMode(extra = {}) {
  wren.state.runs.clear();
  wren.requests.length = 0;
  const env = {
    ...process.env,
    DISCORD_CLIENT_SECRET: '',
    FLUXER_CLIENT_SECRET: '',
    FLUXER_TOKEN: '',
    FLUXER_CLIENT_ID: '',
    DASHBOARD_URL: '',
    UPDATE_CHECK: 'off',
    WISE_WREN_URL: wren.url,
    WISE_WREN_TOKEN: FAKE_TOKEN,
    WISE_WREN_TARGET_ID: String(wren.targetId),
    ...extra,
  };
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', OPEN_MODE],
    { env, timeout: 30_000 }
  );
  return { ...JSON.parse(stdout.trim().split('\n').pop()), stderr };
}

test('open mode: Update now is refused with a 409 (and is not offered) unless WISE_WREN_ALLOW_OPEN_MODE=true', async () => {
  const refused = await openMode();
  assert.equal(refused.getStatus, 200, 'the notice and what Wren sees are still shown');
  assert.equal(refused.status.wren.updateSeen, true);
  assert.equal(refused.status.wren.openMode, true);
  assert.equal(refused.status.wren.canApprove, false);
  assert.match(refused.status.wren.whyNot, /WISE_WREN_ALLOW_OPEN_MODE=true/);
  assert.equal(refused.postStatus, 409);
  assert.equal(refused.post.code, 'open_mode');
  assert.equal(
    wren.requests.filter((r) => r.method === 'POST').length,
    0,
    'Wren was not asked to approve anything'
  );
  assert.match(refused.stderr, /Wise Wren is set up, but the dashboard has no login/);
  assert.doesNotMatch(refused.stderr, new RegExp(FAKE_TOKEN));

  const allowed = await openMode({ WISE_WREN_ALLOW_OPEN_MODE: 'true' });
  assert.equal(allowed.status.wren.openMode, false);
  assert.equal(allowed.status.wren.canApprove, true);
  assert.equal(allowed.postStatus, 200);
  assert.ok(Number.isSafeInteger(allowed.post.runId));
  assert.equal(wren.requests.filter((r) => r.method === 'POST').length, 1);
  assert.doesNotMatch(allowed.stderr, /has no login/, 'no warning once it is allowed on purpose');
});
