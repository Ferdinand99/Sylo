// The Bridge routes of the dashboard API, through the real app with both logins: who may see and change a
// server's bridge, the consent flow across two servers on two platforms, and that one server can never
// reach into another's links. The engine itself is in bridge.engine.test.js.
import './helpers/trustLoopbackProxy.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  F_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const store = await import('../src/db/bridge.js');
const { listAudit } = await import('../src/db/audit.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { ROUTE_ACCESS } = await import('../src/web/lib/routeAccess.js');
const { dropBridgeCache } = await import('../src/modules/bridge.js');
const { useFakes } = await import('./helpers/fakeBridge.js');

const F_KEY = `fluxer:${F_GUILD}`;
const CH = {
  d1: '810000000000000001',
  d2: '810000000000000002',
  f1: '810000000000000003',
  f2: '810000000000000004',
  dNsfw: '810000000000000005',
};
const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
const addChannel = (guild, id, name, nsfw = false) =>
  guild.channels.cache.set(id, {
    id,
    name,
    type: 0,
    nsfw,
    nsfwOverride: null,
    rawPosition: Number(id.slice(-2)),
    guild,
    said: [],
    // Sylo (no member) may do everything; a person may not use a channel that is hidden from them.
    permissionsFor: (member) => ({ has: () => !member?.hidden?.has(id) }),
    async send(payload) {
      this.said.push(payload);
      return { id: '1' };
    },
  });

let fakes;
beforeEach(async () => {
  useFakes(); // the purge below talks to the webhook transport for links the previous test left
  dropBridgeCache();
  for (const key of [D_GUILD, F_KEY, OTHER_D_GUILD]) await purgeGuild(key);
  fakes = useFakes();
  dGuild.channels.cache.clear();
  fGuild.channels.cache.clear();
  fGuild.nsfw = false;
  dGuild.members.cache.clear();
  fGuild.members.cache.clear();
  addChannel(dGuild, CH.d1, 'discord-main');
  addChannel(dGuild, CH.d2, 'discord-two');
  addChannel(dGuild, CH.dNsfw, 'discord-nsfw', true);
  addChannel(fGuild, CH.f1, 'fluxer-main');
  addChannel(fGuild, CH.f2, 'fluxer-two');
  await setGuildModule(D_GUILD, 'bridge', { enabled: true });
  await setGuildModule(F_KEY, 'bridge', { enabled: true });
});

/** A browser that sends its requests from an address of its own, so the sign-in limit is not shared. */
let clients = 0;
function ownBrowser() {
  const b = browser();
  const ip = `10.8.${Math.floor(++clients / 250)}.${clients % 250}`;
  return {
    ...b,
    get: (path, init = {}) => b.get(path, { ...init, headers: { ...init.headers, 'x-forwarded-for': ip } }),
  };
}

/** Someone signed in on a platform, with JSON helpers that carry the CSRF token. */
async function person(platform, { guilds, hidden = [], member = true } = {}) {
  setProfiles();
  if (guilds) profiles[platform].guilds = guilds;
  const b = ownBrowser();
  await signIn(b, platform);
  // The person's member in the server (the channel rights are read from it); `hidden` channels they cannot see.
  if (member) {
    const id = profiles[platform].id;
    (platform === 'discord' ? dGuild : fGuild).members.cache.set(id, { id, hidden: new Set(hidden) });
  }
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  return {
    get: (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      b.get(`/api/v2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}
const dAdmin = () => person('discord');
const fAdmin = () => person('fluxer');
const base = (key) => `/guilds/${key}/modules/bridge`;
const json = (res) => res.json();
const DEFAULTS = { bots: false, joinMessages: false, uploadFiles: true };

test('the routes are listed with the access they need: View reads, Edit changes', () => {
  assert.equal(ROUTE_ACCESS['GET /guilds/:guildId/modules/bridge/config'], 'view');
  for (const [key, level] of Object.entries(ROUTE_ACCESS)) {
    if (key.includes('/modules/bridge/') && key.startsWith('POST ')) assert.equal(level, 'edit', key);
  }
  assert.equal(Object.keys(ROUTE_ACCESS).filter((k) => k.includes('/modules/bridge/')).length, 8);
});

test('nobody signed out, and nobody without Manage Server, can read or change a bridge', async () => {
  const b = ownBrowser();
  const read = await b.get(`/api/v2${base(D_GUILD)}/config`, { headers: { accept: 'application/json' } });
  assert.ok([401, 403].includes(read.status));
  const member = await person('discord', { guilds: [{ id: D_GUILD, owner: false, permissions: '0' }] });
  assert.equal((await member.get(`${base(D_GUILD)}/config`)).status, 403);
  for (const [path, body] of [
    ['/request', { channelId: CH.d1 }],
    ['/accept', { code: 'ABCD-EFGH-JKMN', channelId: CH.d1 }],
    ['/links/1/pause', {}],
    ['/links/1/resume', {}],
    ['/links/1/unlink', {}],
    ['/links/1/options', { options: { bots: true } }],
    ['/requests/1/cancel', {}],
  ]) {
    assert.equal((await member.post(`${base(D_GUILD)}${path}`, body)).status, 403, path);
  }
  assert.equal((await store.pendingCodes(D_GUILD)).length, 0);
  // an admin of one server has nothing in another
  const stranger = await person('discord', { guilds: [{ id: OTHER_D_GUILD, owner: true }] });
  assert.equal((await stranger.get(`${base(D_GUILD)}/config`)).status, 403);
  assert.equal((await stranger.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 })).status, 403);
});

test('a state-changing call without the CSRF token is refused', async () => {
  setProfiles();
  const b = ownBrowser();
  await signIn(b, 'discord');
  const res = await b.get(`/api/v2${base(D_GUILD)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ channelId: CH.d1 }),
  });
  assert.equal(res.status, 403);
  assert.equal((await store.pendingCodes(D_GUILD)).length, 0);
});

test('the overview lists channels, shows what is set up, and says when the module is off', async () => {
  const d = await dAdmin();
  const res = await d.get(`${base(D_GUILD)}/config`);
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.equal(data.platform, 'discord');
  assert.equal(data.bothPlatforms, true);
  assert.equal(data.enabled, true);
  assert.deepEqual(data.limits, { links: 10, requests: 5 });
  assert.deepEqual(data.links, []);
  assert.deepEqual(
    data.channels.map((c) => [c.name, c.ageRestricted, c.taken]),
    [
      ['discord-main', false, false],
      ['discord-two', false, false],
      ['discord-nsfw', true, false],
    ]
  );
  await setGuildModule(D_GUILD, 'bridge', { enabled: false });
  assert.equal((await json(await d.get(`${base(D_GUILD)}/config`))).enabled, false);
  const refused = await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 });
  assert.equal(refused.status, 409);
  assert.match((await json(refused)).error, /Turn the Bridge module on/);
});

test('asking, then accepting in the other server on the other platform, links the two channels', async () => {
  const d = await dAdmin();
  const f = await fAdmin();

  const asked = await d.post(`${base(D_GUILD)}/request`, {
    channelId: CH.d1,
    options: { joinMessages: true },
  });
  assert.equal(asked.status, 200);
  const { code, expiresAt, overview } = await json(asked);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(expiresAt > Date.now());
  assert.equal(overview.requests.length, 1);
  assert.ok(!JSON.stringify(overview).includes(code), 'the code is shown once and never listed');
  assert.equal(overview.channels.find((c) => c.id === CH.d1).taken, true);

  // asking again for the same channel is refused, and the Fluxer server sees none of it
  assert.equal((await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 })).status, 409);
  assert.deepEqual((await json(await f.get(`${base(F_KEY)}/config`))).requests, []);

  const accepted = await f.post(`${base(F_KEY)}/accept`, { code: code.toLowerCase(), channelId: CH.f1 });
  assert.equal(accepted.status, 200);
  const mine = (await json(accepted)).overview;
  assert.equal(mine.platform, 'fluxer');
  assert.equal(mine.links.length, 1);
  const view = mine.links[0];
  assert.equal(view.status, 'active');
  assert.deepEqual(
    [view.mine.channel, view.theirs.channel, view.theirs.server, view.theirs.platform],
    ['fluxer-main', 'discord-main', 'D-main', 'discord']
  );
  assert.deepEqual(
    view.theirOptions,
    { bots: false, joinMessages: true, uploadFiles: true },
    'what the other side chose to share'
  );
  assert.deepEqual(view.options, { bots: false, joinMessages: false, uploadFiles: true });

  // Discord sees the same link from its side, and the request is gone
  const theirs = await json(await d.get(`${base(D_GUILD)}/config`));
  assert.equal(theirs.requests.length, 0);
  assert.equal(theirs.links.length, 1);
  assert.deepEqual(
    [theirs.links[0].mine.channel, theirs.links[0].theirs.channel],
    ['discord-main', 'fluxer-main']
  );

  // never a webhook or its token to the browser
  const everything = JSON.stringify([mine, theirs]);
  for (const hook of fakes.transport.hooks) assert.ok(!everything.includes(hook.token));
  assert.ok(!/token|webhook/i.test(everything));

  assert.ok((await listAudit(D_GUILD)).some((e) => e.action === 'bridge:link'));
  assert.ok((await listAudit(F_KEY)).some((e) => e.action === 'bridge:link'));
  assert.ok(dGuild.channels.cache.get(CH.d1).said[0].content.includes('Bridge on'));
  assert.ok(fGuild.channels.cache.get(CH.f1).said[0].content.includes('Bridge on'));
});

test('someone without Edit in the accepting server cannot use a code there, whatever they hold in the other', async () => {
  const d = await dAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  // the Discord admin has no right in the Fluxer server
  const refused = await d.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 });
  assert.equal(refused.status, 403);
  // and a Fluxer member without Manage Server cannot either
  const member = await person('fluxer', { guilds: [{ id: F_GUILD, owner: false, permissions: '0' }] });
  assert.equal((await member.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 403);
  assert.equal((await store.pendingCodes(D_GUILD)).length, 1, 'the code is still unused');
  assert.equal(await store.linkForChannel(F_KEY, CH.f1), null);
});

test('a wrong code, a used code, your own code and the wrong platform are all refused', async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));

  const wrong = await f.post(`${base(F_KEY)}/accept`, { code: 'ABCD-EFGH-JKMN', channelId: CH.f1 });
  assert.equal(wrong.status, 404);
  assert.match((await json(wrong)).error, /not valid, has expired or was already used/);
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code: '', channelId: CH.f1 })).status, 404);
  assert.equal(
    (await f.post(`${base(F_KEY)}/accept`, { code, channelId: 'junk' })).status,
    400,
    'no channel'
  );
  assert.equal(
    (await d.post(`${base(D_GUILD)}/accept`, { code, channelId: CH.d2 })).status,
    409,
    'your own code'
  );

  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 200);
  assert.equal(
    (await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f2 })).status,
    404,
    'a used code'
  );
});

test('too many wrong codes lock the attempts for a while, for that person in that server', async () => {
  const f = await fAdmin();
  for (let i = 0; i < 6; i += 1) {
    assert.equal(
      (await f.post(`${base(F_KEY)}/accept`, { code: 'ABCD-EFGH-JKM' + i, channelId: CH.f1 })).status,
      404
    );
  }
  const locked = await f.post(`${base(F_KEY)}/accept`, { code: 'ABCD-EFGH-JKMN', channelId: CH.f1 });
  assert.equal(locked.status, 429);
  assert.match((await json(locked)).error, /Wait a few minutes/);
  // a valid code does not get around it
  const d = await dAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 429);
  assert.equal((await store.pendingCodes(D_GUILD)).length, 1);
});

test('an age-restricted channel is refused for an ordinary one when asking and when accepting', async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.dNsfw }));
  const refused = await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 });
  assert.equal(refused.status, 400);
  assert.match(
    (await json(refused)).error,
    /age-restricted channel can only be bridged with another age-restricted/
  );
  assert.equal(fakes.transport.hooks.length, 0);
  addChannel(fGuild, '810000000000000006', 'fluxer-nsfw', true);
  assert.equal(
    (await f.post(`${base(F_KEY)}/accept`, { code, channelId: '810000000000000006' })).status,
    200
  );
});

test('pause, resume and unlink from either side, with the rules about who may resume', async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 });
  const id = (await store.linksOfGuild(D_GUILD))[0].id;

  const paused = await d.post(`${base(D_GUILD)}/links/${id}/pause`);
  assert.equal(paused.status, 200);
  assert.equal((await json(paused)).overview.links[0].pausedByMe, true);
  assert.equal((await json(await f.get(`${base(F_KEY)}/config`))).links[0].pausedByThem, true);
  const blocked = await f.post(`${base(F_KEY)}/links/${id}/resume`);
  assert.equal(blocked.status, 403);
  assert.match((await json(blocked)).error, /only they can resume/);
  assert.equal((await d.post(`${base(D_GUILD)}/links/${id}/resume`)).status, 200);
  assert.equal((await store.getLink(id)).status, 'active');

  const opts = await f.post(`${base(F_KEY)}/links/${id}/options`, { options: { bots: true, junk: 1 } });
  assert.deepEqual((await json(opts)).overview.links[0].options, {
    bots: true,
    joinMessages: false,
    uploadFiles: true,
  });
  assert.deepEqual(
    (await store.getLink(id)).optionsA,
    DEFAULTS,
    "the other server's options are not touched"
  );

  const unlinked = await f.post(`${base(F_KEY)}/links/${id}/unlink`);
  assert.equal(unlinked.status, 200);
  assert.deepEqual((await json(unlinked)).overview.links, []);
  assert.equal(await store.getLink(id), null);
  assert.equal(fakes.transport.deleted.length, 2, 'both webhooks were deleted');
  assert.ok((await listAudit(D_GUILD)).some((e) => e.action === 'bridge:unlink'));
});

test("another server's link id is a 404 in every route, and nothing of it changes", async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 });
  const id = (await store.linksOfGuild(D_GUILD))[0].id;

  const stranger = await person('discord', { guilds: [{ id: OTHER_D_GUILD, owner: true }] });
  for (const path of ['pause', 'resume', 'unlink']) {
    const res = await stranger.post(`${base(OTHER_D_GUILD)}/links/${id}/${path}`);
    assert.equal(res.status, 404, path);
  }
  assert.equal(
    (await stranger.post(`${base(OTHER_D_GUILD)}/links/${id}/options`, { options: { bots: true } })).status,
    404
  );
  assert.equal((await stranger.post(`${base(OTHER_D_GUILD)}/requests/1/cancel`)).status, 404);
  assert.equal((await stranger.post(`${base(OTHER_D_GUILD)}/links/abc/pause`)).status, 404);
  const link = await store.getLink(id);
  assert.deepEqual([link.status, link.optionsA, link.optionsB], ['active', DEFAULTS, DEFAULTS]);
});

test('a request can be cancelled by the server that made it, which kills its code', async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code, overview } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  const requestId = overview.requests[0].id;
  assert.equal(
    (await f.post(`${base(F_KEY)}/requests/${requestId}/cancel`)).status,
    404,
    'not by the other server'
  );
  const cancelled = await d.post(`${base(D_GUILD)}/requests/${requestId}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.deepEqual((await json(cancelled)).overview.requests, []);
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 404);
});

test('a person must be able to view, read and send in the channel themselves: a hidden staff channel is refused', async () => {
  const d = await person('discord', { hidden: [CH.d2] });
  const hiddenAsk = await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d2 });
  assert.equal(hiddenAsk.status, 403);
  assert.match((await json(hiddenAsk)).error, /view, read and send in #discord-two yourself/);
  assert.equal((await store.pendingCodes(D_GUILD)).length, 0, 'no request was made');

  const ok = await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 });
  assert.equal(ok.status, 200);
  const { code } = await json(ok);

  const f = await person('fluxer', { hidden: [CH.f2] });
  const hiddenAccept = await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f2 });
  assert.equal(hiddenAccept.status, 403);
  assert.equal((await store.pendingCodes(D_GUILD)).length, 1, 'the code is still unused');
  assert.equal(fakes.transport.hooks.length, 0, 'and no webhook was made');
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 200);
});

test('a person Sylo cannot look up in the server (no member) is refused: it fails closed', async () => {
  const d = await person('discord', { member: false });
  const res = await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 });
  assert.equal(res.status, 403);
  assert.match((await json(res)).error, /yourself/);
});

test('a Fluxer channel in an age-restricted category or server is refused for an ordinary Discord channel', async () => {
  const d = await dAdmin();
  const f = await fAdmin();
  const { code } = await json(await d.post(`${base(D_GUILD)}/request`, { channelId: CH.d1 }));
  // a category with its own override, the channel itself inheriting
  fGuild.channels.cache.set('810000000000000007', {
    id: '810000000000000007',
    name: 'adult',
    type: 4,
    nsfwOverride: true,
    nsfw: false,
  });
  fGuild.channels.cache.get(CH.f1).parentId = '810000000000000007';
  const category = await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 });
  assert.equal(category.status, 400);
  assert.match((await json(category)).error, /age-restricted/);
  // the server itself is age-restricted
  fGuild.channels.cache.get(CH.f1).parentId = null;
  fGuild.nsfw = true;
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 400);
  // what cannot be read counts as age-restricted
  fGuild.nsfw = false;
  fGuild.channels.cache.get(CH.f1).nsfwOverride = undefined;
  assert.equal((await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status, 400);
  assert.equal(fakes.transport.hooks.length, 0);
  fGuild.channels.cache.get(CH.f1).nsfwOverride = null;
  assert.equal(
    (await f.post(`${base(F_KEY)}/accept`, { code, channelId: CH.f1 })).status,
    200,
    'clear: it links'
  );
});
