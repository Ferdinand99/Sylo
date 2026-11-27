// The Mirror to Fluxer routes through the real app with both logins: asking, agreeing with the code, the
// preview, the copy and the controls; that only a server's owner can do any of it (not an Administrator, not an
// Edit holder); and that a code, a pair or a server id of another server reaches nothing.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
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
const db = await import('../src/db/mirror.js');
const { listAudit } = await import('../src/db/audit.js');

const F_KEY = `fluxer:${F_GUILD}`;
const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);

let people = 0;
/** A browser that sends its requests from an address of its own (the routes are rate limited per person). */
function own() {
  const b = browser();
  const ip = `10.7.${Math.floor(++people / 250)}.${people % 250}`;
  return {
    ...b,
    get: (path, init = {}) => b.get(path, { ...init, headers: { ...init.headers, 'x-forwarded-for': ip } }),
  };
}

/**
 * Sign in with Discord, Fluxer or both; every request is JSON with the CSRF token. `admin` signs in with
 * Administrator on the Discord server instead of owning it. The server's owner is set by the test (`owners`).
 */
async function person({ discord = false, fluxer = false, admin = false } = {}) {
  setProfiles();
  if (admin) profiles.discord.guilds = [{ id: D_GUILD, owner: false, permissions: '8' }];
  const ids = { discord: profiles.discord.id, fluxer: profiles.fluxer.id };
  const b = own();
  if (discord) await signIn(b, 'discord');
  if (fluxer) await signIn(b, 'fluxer', { connect: discord });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  return {
    ids,
    get: (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      b.get(`/api/v2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

/** Make these people the owners of the two fake servers. */
const owners = ({ discord, fluxer }) => {
  dGuild.ownerId = discord ?? 'nobody-discord';
  fGuild.ownerId = fluxer ?? 'nobody-fluxer';
};

const reset = async () => {
  for (const key of [D_GUILD, OTHER_D_GUILD, F_KEY])
    for (const p of await db.pairsOfGuild(key)) await db.deletePair(p.id);
};

test('the owner of the Discord server asks; the owner of the Fluxer server agrees with the one-time code; then the whole flow', async () => {
  await reset();
  const anna = await person({ discord: true });
  const bo = await person({ fluxer: true });
  owners({ discord: anna.ids.discord, fluxer: bo.ids.fluxer });

  const empty = await (await anna.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.deepEqual(
    [empty.platform, empty.canMirror, empty.pair, empty.isOwner],
    ['discord', true, null, true]
  );
  assert.ok(!('candidates' in empty), 'the Fluxer servers come from their own route');
  assert.equal(empty.beta, true); // Mirror is a beta page: the page and the app show the Beta mark
  const overview = await (await anna.get(`/guilds/${D_GUILD}/overview`)).json();
  assert.deepEqual(overview.betaPages, ['mirror']);

  const res = await anna.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_GUILD });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(body.agreed, false);
  assert.equal(body.pair.status, 'pending');
  assert.equal(body.pair.otherName, null, 'the Fluxer name is not shown before its owner agrees');
  assert.ok(!JSON.stringify(body).includes('codeHash'));
  assert.ok(
    !JSON.stringify(await (await anna.get(`/guilds/${D_GUILD}/mirror`)).json()).includes(body.code),
    'the code is shown once'
  );
  const pending = await db.getPairBySource(D_GUILD);
  assert.deepEqual([pending.sourceConsentUser, pending.targetConsentUser], [anna.ids.discord, '']);

  // Nothing can be previewed or started until both agree.
  assert.equal((await anna.get(`/guilds/${D_GUILD}/mirror/preview`)).status, 409);
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true })).status, 409);

  const seen = await (await bo.get(`/guilds/${F_KEY}/mirror`)).json();
  assert.deepEqual([seen.platform, seen.pair.side, seen.pair.status], ['fluxer', 'target', 'pending']);
  assert.equal(seen.pair.otherName, 'D-main', 'they see which server asks');
  assert.equal(seen.pair.requestedBy, '', "the other server's dashboard user is not named to them");
  assert.equal((await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: 'AAAA-AAAA' })).status, 403);
  assert.equal(
    (await anna.post(`/guilds/${D_GUILD}/mirror/accept`, { code: body.code })).status,
    400,
    'the code is entered on the Fluxer server'
  );
  const ok = await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: body.code });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).pair.status, 'ready');
  assert.equal(
    (await db.getPairBySource(D_GUILD)).targetConsentUser,
    bo.ids.fluxer,
    'the Fluxer owner is recorded'
  );
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: body.code })).status,
    404,
    'the code works once'
  );
  const audit = (await listAudit(D_GUILD, 20)).map((e) => e.action);
  assert.ok(audit.includes('mirror:request') && audit.includes('mirror:agree'));

  // The preview reads, the copy needs a confirmation, and a started copy shows progress and a report.
  const preview = await (await anna.get(`/guilds/${D_GUILD}/mirror/preview`)).json();
  assert.equal(preview.ok, true);
  assert.deepEqual(
    preview.steps.map((s) => s.kind),
    ['guild', 'bridge']
  );
  assert.equal(preview.target.name, 'F-main');
  assert.ok(!('spec' in preview.steps[0]), 'the preview names steps; it does not hand out whole specs');
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/start`, {})).status, 400);
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: 'yes' })).status, 400);
  const started = await anna.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true });
  assert.equal(started.status, 200);
  const state = await started.json();
  assert.equal(state.pair.status, 'copying');
  assert.equal(state.progress.total, 2);
  const report = await (await anna.get(`/guilds/${D_GUILD}/mirror/report`)).json();
  assert.deepEqual(
    report.items.map((i) => i.kind),
    ['guild', 'bridge']
  );
  // Real deletion: the Discord owner can only ask; the owner of the Fluxer server decides.
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/deletes`, { allow: true })).status,
    409,
    'nothing has been asked for yet'
  );
  const opts = await anna.post(`/guilds/${D_GUILD}/mirror/options`, {
    continuous: false,
    mirrorDeletes: true,
    bogus: 1,
  });
  const optionsNow = (await opts.json()).pair.options;
  assert.deepEqual(
    [optionsNow.continuous, optionsNow.mirrorDeletes, optionsNow.mirrorDeletesRequested],
    [false, false, true],
    'asking is not switching on'
  );
  assert.equal(optionsNow.bogus, undefined);
  assert.equal(
    (await anna.post(`/guilds/${D_GUILD}/mirror/deletes`, { allow: true })).status,
    404,
    'not from the Discord side'
  );
  const seenByBo = await (await bo.get(`/guilds/${F_KEY}/mirror`)).json();
  assert.equal(seenByBo.pair.options.mirrorDeletesRequested, true, 'the Fluxer owner sees the request');
  const allowed = await (await bo.post(`/guilds/${F_KEY}/mirror/deletes`, { allow: true })).json();
  assert.equal(allowed.pair.options.mirrorDeletes, true, 'the Fluxer owner switched it on');
  const again = await (
    await anna.post(`/guilds/${D_GUILD}/mirror/options`, { mirrorDeletes: true, continuous: false })
  ).json();
  assert.equal(again.pair.options.mirrorDeletes, true, 'asking again does not change it');
  const off = await (await anna.post(`/guilds/${D_GUILD}/mirror/options`, { mirrorDeletes: false })).json();
  assert.deepEqual(
    [off.pair.options.mirrorDeletes, off.pair.options.mirrorDeletesRequested],
    [false, false],
    'either side can switch it off'
  );
  assert.ok((await listAudit(F_KEY, 20)).some((e) => e.action === 'mirror:deletes'));

  // Either owner can pause; only the owner that paused can resume it.
  assert.equal((await bo.post(`/guilds/${F_KEY}/mirror/resume`)).status, 409, 'only a paused mirror resumes');
  const paused = await bo.post(`/guilds/${F_KEY}/mirror/pause`);
  assert.equal((await paused.json()).pair.pausedBy, 'target');
  const refused = await anna.post(`/guilds/${D_GUILD}/mirror/resume`);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /only that owner can resume/);
  assert.equal((await bo.post(`/guilds/${F_KEY}/mirror/resume`)).status, 200);
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'copying');
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/remove`)).status,
    409,
    'a running mirror is stopped before it is removed'
  );
  const stopped = await bo.post(`/guilds/${F_KEY}/mirror/stop`);
  assert.equal((await stopped.json()).pair.status, 'stopped');
  const pair = await db.getPairBySource(D_GUILD);
  assert.deepEqual(
    [pair.sourceConsentBy, pair.targetConsentBy, pair.sourceConsentUser, pair.targetConsentUser],
    ['', '', '', ''],
    'stopping clears the agreement'
  );
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/remove`)).status, 200);
  assert.equal(await db.getPairBySource(D_GUILD), null);
});

test('the same person who owns both servers agrees on both sides at once', async () => {
  await reset();
  const both = await person({ discord: true, fluxer: true });
  owners({ discord: both.ids.discord, fluxer: both.ids.fluxer });
  const list = await (await both.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json();
  assert.deepEqual(
    list.servers.map((c) => c.id),
    [F_KEY],
    'the Fluxer servers this person owns are offered'
  );
  const res = await both.post(`/guilds/${D_GUILD}/mirror/request`, {
    targetGuildId: F_KEY,
    options: { mirrorDeletes: true },
  });
  const body = await res.json();
  assert.equal(
    body.pair.options.mirrorDeletes,
    true,
    'the owner of both servers can switch deletion on at once'
  );
  assert.equal(body.code, null);
  assert.equal(body.agreed, true);
  assert.equal(body.pair.status, 'ready');
  assert.equal(body.pair.otherName, 'F-main');
  const pair = await db.getPairBySource(D_GUILD);
  assert.deepEqual([pair.sourceConsentUser, pair.targetConsentUser], [both.ids.discord, both.ids.fluxer]);
});

test('an owner of one server who is only an Administrator of the other is not enough', async () => {
  await reset();
  const mixed = await person({ discord: true, fluxer: true });
  owners({ discord: mixed.ids.discord, fluxer: 'someone-else' }); // owns Discord, is not the Fluxer owner
  const list = await (await mixed.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json();
  assert.deepEqual(list.servers, [], 'a Fluxer server they do not own is not offered');
  const res = await mixed.post(`/guilds/${D_GUILD}/mirror/request`, {
    targetGuildId: F_KEY,
    options: { mirrorDeletes: true },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.agreed, false, 'no automatic agreement for a server they do not own');
  assert.deepEqual(
    [body.pair.options.mirrorDeletes, body.pair.options.mirrorDeletesRequested],
    [false, true],
    'deletion is only asked for: the Fluxer owner has to turn it on'
  );
  assert.ok(body.code, 'the Fluxer owner has to agree with the code');
  assert.equal((await mixed.post(`/guilds/${F_KEY}/mirror/accept`, { code: body.code })).status, 403);
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'pending');
});

test('an Administrator who is not the owner can look, but cannot ask, agree, change, start, pause, resume, stop or remove', async () => {
  await reset();
  const owner = await person({ discord: true, fluxer: true });
  owners({ discord: owner.ids.discord, fluxer: owner.ids.fluxer });
  await owner.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_KEY });
  await owner.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true });

  const admin = await person({ discord: true, admin: true });
  const sees = await admin.get(`/guilds/${D_GUILD}/mirror`);
  assert.equal(sees.status, 200, 'they have the dashboard access, so they can look');
  const seen = await sees.json();
  assert.equal(seen.isOwner, false);
  assert.equal(seen.pair.status, 'copying', 'the status is readable');
  assert.equal((await admin.get(`/guilds/${D_GUILD}/mirror/preview`)).status, 200);
  assert.equal((await admin.get(`/guilds/${D_GUILD}/mirror/report`)).status, 200);
  for (const [path, body] of [
    ['request', { targetGuildId: F_KEY }],
    ['options', { continuous: false }],
    ['deletes', { allow: true }],
    ['start', { confirm: true }],
    ['pause', {}],
    ['resume', {}],
    ['stop', {}],
    ['remove', {}],
  ]) {
    const res = await admin.post(`/guilds/${D_GUILD}/mirror/${path}`, body);
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).error, /Only the server owner can/, path);
  }
  const pair = await db.getPairBySource(D_GUILD);
  assert.equal(pair.status, 'copying', 'nothing changed');
  assert.equal(pair.options.continuous, true);
  // The owner of the Discord server cannot act on the Fluxer side either, and a stranger gets nothing there.
  assert.equal((await owner.post(`/guilds/${F_KEY}/mirror/pause`)).status, 200, 'the owner of both can');
  const other = await person({ fluxer: true });
  assert.equal((await other.post(`/guilds/${F_KEY}/mirror/stop`)).status, 403);
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'paused');
});

test('a server that changes hands pauses the mirror until its new owner confirms', async () => {
  await reset();
  const first = await person({ discord: true, fluxer: true });
  owners({ discord: first.ids.discord, fluxer: first.ids.fluxer });
  await first.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_KEY });
  await first.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true });
  const pair = await db.getPairBySource(D_GUILD);

  // The Fluxer server is handed to someone else: the engine pauses at the next piece of work.
  const next = await person({ fluxer: true });
  fGuild.ownerId = next.ids.fluxer;
  const { mirror } = await import('../src/mirror/index.js');
  await mirror.runPair(pair.id);
  const paused = await db.getPair(pair.id);
  assert.deepEqual([paused.status, paused.pauseKind], ['paused', 'ownership']);

  // The old owner cannot resume it; the new one confirms and the mirror goes on.
  assert.equal((await first.post(`/guilds/${F_KEY}/mirror/resume`)).status, 403);
  const resumed = await next.post(`/guilds/${F_KEY}/mirror/resume`);
  assert.equal(resumed.status, 200);
  const after = await db.getPair(pair.id);
  assert.equal(after.status, 'copying');
  assert.equal(after.targetConsentUser, next.ids.fluxer);
});

test('the page gets when the last error happened, and nothing once it cleared', async () => {
  await reset();
  const owner = await person({ discord: true, fluxer: true });
  owners({ discord: owner.ids.discord, fluxer: owner.ids.fluxer });
  await owner.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_KEY });
  await owner.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true });
  const pair = await db.getPairBySource(D_GUILD);
  await db.updatePair(pair.id, {
    status: 'paused',
    resumeStatus: 'live',
    pauseKind: 'unreachable',
    pausedBy: 'system',
    lastError: 'Fluxer could not be reached: fetch failed',
    lastErrorAt: 1_800_000_000_000,
  });
  const seen = await (await owner.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.deepEqual(
    [seen.pair.pauseKind, seen.pair.lastError, seen.pair.lastErrorAt],
    ['unreachable', 'Fluxer could not be reached: fetch failed', 1_800_000_000_000]
  );
  // A pause from before the time was kept shows when it was paused.
  const older = await db.updatePair(pair.id, { lastErrorAt: 0 }, 1_700_000_000_000);
  const legacy = await (await owner.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.equal(legacy.pair.lastErrorAt, older.updatedAt);
  await db.updatePair(pair.id, { status: 'live', pauseKind: '', lastError: '', lastErrorAt: 0 });
  const cleared = await (await owner.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.deepEqual([cleared.pair.lastError, cleared.pair.lastErrorAt], ['', 0]);
});

test('another server cannot be reached: not by its id, not by a pair, not by a code', async () => {
  await reset();
  const anna = await person({ discord: true });
  const bo = await person({ fluxer: true });
  owners({ discord: anna.ids.discord, fluxer: bo.ids.fluxer });
  // The owner of D_GUILD has no right in OTHER_D_GUILD or in the Fluxer server.
  for (const [path, body] of [
    [`/guilds/${OTHER_D_GUILD}/mirror/request`, { targetGuildId: F_GUILD }],
    [`/guilds/${OTHER_D_GUILD}/mirror/options`, {}],
    [`/guilds/${OTHER_D_GUILD}/mirror/start`, { confirm: true }],
    [`/guilds/${F_KEY}/mirror/accept`, { code: 'AAAA-AAAA' }],
    [`/guilds/${F_KEY}/mirror/stop`, {}],
  ]) {
    assert.equal((await anna.post(path, body)).status, 403, path);
  }
  for (const path of [
    `/guilds/${OTHER_D_GUILD}/mirror`,
    `/guilds/${F_KEY}/mirror`,
    `/guilds/${F_KEY}/mirror/report`,
  ]) {
    assert.equal((await anna.get(path)).status, 403, path);
  }
  assert.equal(await db.getPairBySource(OTHER_D_GUILD), null);

  const { code } = await (
    await anna.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_GUILD })
  ).json();
  assert.equal(
    (await bo.post(`/guilds/${D_GUILD}/mirror/accept`, { code })).status,
    403,
    'the Fluxer owner has no right on the Discord server'
  );
  // A code for another server finds nothing here.
  await db.deletePair((await db.getPairBySource(D_GUILD)).id);
  const other = await db.createPair({
    sourceGuild: OTHER_D_GUILD,
    targetGuild: 'fluxer:900000000000000299',
    status: 'pending',
  });
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code })).status,
    404,
    'no request waits for this Fluxer server'
  );
  await db.deletePair(other.id);
});

test('asking is checked: a Fluxer server cannot ask, the target must be a Fluxer server Sylo is in', async () => {
  await reset();
  const both = await person({ discord: true, fluxer: true });
  owners({ discord: both.ids.discord, fluxer: both.ids.fluxer });
  assert.equal((await both.post(`/guilds/${F_KEY}/mirror/request`, { targetGuildId: D_GUILD })).status, 400);
  assert.equal(
    (await both.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: D_GUILD })).status,
    404,
    'a Discord id read as a Fluxer id: Sylo is not there'
  );
  assert.equal(
    (await both.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: 'nonsense' })).status,
    400
  );
  assert.equal(
    (await both.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: '900000000000000777' })).status,
    404,
    'Sylo is not there'
  );
  assert.equal(await db.getPairBySource(D_GUILD), null);
  assert.equal(
    (await both.get(`/guilds/${F_KEY}/mirror/preview`)).status,
    404,
    'a Fluxer server has no preview'
  );
});

test('signed out and without a CSRF token, nothing works', async () => {
  const b = own();
  assert.ok(
    [401, 403].includes(
      (await b.get(`/api/v2/guilds/${D_GUILD}/mirror`, { headers: { accept: 'application/json' } })).status
    )
  );
  const anna = await person({ discord: true });
  owners({ discord: anna.ids.discord });
  const noToken = await own().get(`/api/v2/guilds/${D_GUILD}/mirror/request`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.ok([401, 403].includes(noToken.status));
  assert.equal((await anna.get(`/guilds/${D_GUILD}/mirror`)).status, 200);
});

// ---- the picker of the Fluxer servers ------------------------------------------------------------------

const F_OTHER_OWNER = '900000000000000204'; // Fluxer says it is theirs (OAuth), the gateway says it is somebody else's
const F_NOT_LISTED = '900000000000000205'; // the gateway says they own it, their login does not list it
const SYLO_ROLE = '900000000000000301';

/** Add servers to the fake Fluxer bot, run `fn`, and take them away again. */
async function withFluxerGuilds(extra, fn) {
  const cache = runtime.clients.fluxer.guilds.cache;
  for (const g of extra) cache.set(g.id, g);
  try {
    return await fn();
  } finally {
    for (const g of extra) cache.delete(g.id);
  }
}
const copyOfF = (id, name, ownerId) => ({ ...fGuild, id, name, ownerId });

/** Sylo's own member on a fake Fluxer server: its permissions and where its role stands among `roles`. */
function syloIs(guild, { administrator = true, roles = [] } = {}) {
  guild.members = {
    ...guild.members,
    me: {
      permissions: { has: () => administrator },
      roles: { highest: { id: SYLO_ROLE, position: 5 } },
    },
  };
  guild.roles = { cache: new Map(roles.map((r) => [r.id, r])) };
}

test('the picker lists the Fluxer servers the person owns and Sylo is in, with a note for what Sylo lacks there', async () => {
  await reset();
  const both = await person({ discord: true, fluxer: true });
  owners({ discord: both.ids.discord, fluxer: both.ids.fluxer });
  const saved = { members: fGuild.members, roles: fGuild.roles, memberCount: fGuild.memberCount };
  try {
    // Sylo is not the top role, and lacks Administrator.
    syloIs(fGuild, {
      administrator: false,
      roles: [
        { id: SYLO_ROLE, name: 'Sylo', position: 5 },
        { id: '900000000000000302', name: 'Admins', position: 9 },
      ],
    });
    fGuild.memberCount = 42;
    const res = await both.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.connected, true);
    assert.equal(body.servers.length, 1);
    const [one] = body.servers;
    assert.deepEqual(
      [one.id, one.name, one.memberCount, one.inUse, one.icon],
      [F_KEY, 'F-main', 42, false, null]
    );
    assert.deepEqual(one.notes.map((n) => n.code).sort(), ['role-hierarchy', 'target-permissions']);

    // Sylo is the top role with Administrator: no notes.
    syloIs(fGuild, { roles: [{ id: SYLO_ROLE, name: 'Sylo', position: 5 }] });
    const clean = (await (await both.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json()).servers[0];
    assert.deepEqual(clean.notes, []);

    // A server that is already part of a mirror says so.
    await both.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_KEY });
    const taken = (await (await both.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json()).servers[0];
    assert.equal(taken.inUse, true);
  } finally {
    Object.assign(fGuild, saved);
    await reset();
  }
});

test('the picker never names a Fluxer server the person does not own', async () => {
  await reset();
  const other = copyOfF(F_OTHER_OWNER, 'Secret-other-server', 'somebody-else');
  const unlisted = copyOfF(F_NOT_LISTED, 'Secret-unlisted-server', 'placeholder');
  await withFluxerGuilds([other, unlisted], async () => {
    setProfiles();
    profiles.fluxer.guilds = [
      { id: F_GUILD, owner: true },
      { id: F_OTHER_OWNER, owner: true },
    ];
    const b = own();
    await signIn(b, 'discord');
    await signIn(b, 'fluxer', { connect: true });
    const get = (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } });
    dGuild.ownerId = profiles.discord.id;
    fGuild.ownerId = 'somebody-else';
    other.ownerId = 'somebody-else';
    unlisted.ownerId = profiles.fluxer.id;

    const text = await (await get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).text();
    const body = JSON.parse(text);
    assert.deepEqual(body.servers, [], 'no server they own: an empty list');
    for (const secret of [
      'F-main',
      'Secret-other-server',
      'Secret-unlisted-server',
      F_GUILD,
      F_OTHER_OWNER,
      F_NOT_LISTED,
    ]) {
      assert.ok(!text.includes(secret), `${secret} is not in the answer`);
    }

    // Now they own the first one only: the other two stay out.
    fGuild.ownerId = profiles.fluxer.id;
    const mine = await (await get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json();
    assert.deepEqual(
      mine.servers.map((x) => x.id),
      [F_KEY]
    );
  });
});

test('the picker says when no Fluxer login is connected, and only the owner of the Discord server may ask', async () => {
  await reset();
  const discordOnly = await person({ discord: true });
  owners({ discord: discordOnly.ids.discord, fluxer: discordOnly.ids.fluxer });
  const none = await (await discordOnly.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).json();
  assert.deepEqual([none.connected, none.servers], [false, []]);

  const admin = await person({ discord: true, fluxer: true, admin: true });
  owners({ discord: 'somebody-else', fluxer: admin.ids.fluxer });
  const refused = await admin.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`);
  assert.equal(refused.status, 403);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.code, 'owner-only');
  assert.ok(!JSON.stringify(refusedBody).includes('F-main'));

  const onFluxer = await person({ discord: true, fluxer: true });
  owners({ discord: onFluxer.ids.discord, fluxer: onFluxer.ids.fluxer });
  assert.equal((await onFluxer.get(`/guilds/${F_KEY}/mirror/fluxer-servers`)).status, 400);

  const out = own();
  assert.ok(
    [401, 403].includes(
      (
        await out.get(`/api/v2/guilds/${D_GUILD}/mirror/fluxer-servers`, {
          headers: { accept: 'application/json' },
        })
      ).status
    ),
    'signed out'
  );
});

test('the picker is rate limited and classified in the access table', async () => {
  await reset();
  const { ROUTE_ACCESS } = await import('../src/web/lib/routeAccess.js');
  assert.equal(ROUTE_ACCESS['GET /guilds/:guildId/mirror/fluxer-servers'], 'edit');
  const both = await person({ discord: true, fluxer: true });
  owners({ discord: both.ids.discord, fluxer: both.ids.fluxer });
  let last = 0;
  for (let i = 0; i < 14; i++) last = (await both.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).status;
  assert.equal(last, 429);
  // Another person has a budget of their own.
  const next = await person({ discord: true, fluxer: true });
  owners({ discord: next.ids.discord, fluxer: next.ids.fluxer });
  assert.equal((await next.get(`/guilds/${D_GUILD}/mirror/fluxer-servers`)).status, 200);
});
