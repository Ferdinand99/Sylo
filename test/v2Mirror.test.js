// The Mirror to Fluxer routes through the real app with both logins: asking, agreeing with the code, the
// preview, the copy and the controls; who may do what on which server; and that a code, a pair or a server id of
// another server reaches nothing.
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

/** Sign in with Discord, Fluxer or both; every request is JSON with the CSRF token. */
async function person({ discord = false, fluxer = false } = {}) {
  setProfiles();
  // The person owns the fake Fluxer server, so the live check of their right there passes.
  fGuild.ownerId = profiles.fluxer.id;
  const b = own();
  if (discord) await signIn(b, 'discord');
  if (fluxer) await signIn(b, 'fluxer', { connect: discord });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  return {
    get: (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      b.get(`/api/v2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

const reset = async () => {
  for (const key of [D_GUILD, OTHER_D_GUILD, F_KEY])
    for (const p of await db.pairsOfGuild(key)) await db.deletePair(p.id);
};

test('a Discord admin asks: the Fluxer side must still agree, and the answer carries a one-time code', async () => {
  await reset();
  const anna = await person({ discord: true });
  const empty = await (await anna.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.deepEqual([empty.platform, empty.canMirror, empty.pair], ['discord', true, null]);
  assert.equal(empty.candidates.length, 0, 'this person manages no Fluxer server');

  const res = await anna.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_GUILD });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(body.agreed, false);
  assert.equal(body.pair.status, 'pending');
  assert.equal(body.pair.otherName, null, 'the Fluxer name is not shown before someone there agrees');
  assert.ok(!JSON.stringify(body).includes('codeHash'));
  assert.ok(
    !JSON.stringify(await (await anna.get(`/guilds/${D_GUILD}/mirror`)).json()).includes(body.code),
    'the code is shown once'
  );

  // Nothing can be previewed or started until both agree.
  assert.equal((await anna.get(`/guilds/${D_GUILD}/mirror/preview`)).status, 409);
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true })).status, 409);
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'pending');

  // Someone with Edit on the Fluxer server enters the code there.
  const bo = await person({ fluxer: true });
  const seen = await (await bo.get(`/guilds/${F_KEY}/mirror`)).json();
  assert.deepEqual([seen.platform, seen.pair.side, seen.pair.status], ['fluxer', 'target', 'pending']);
  assert.equal(seen.pair.otherName, 'D-main', 'they see who asks');
  assert.equal((await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: 'AAAA-AAAA' })).status, 403);
  assert.equal(
    (await anna.post(`/guilds/${D_GUILD}/mirror/accept`, { code: body.code })).status,
    400,
    'the code is entered on the Fluxer server'
  );
  const ok = await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: body.code });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).pair.status, 'ready');
  assert.equal((await db.getPairBySource(D_GUILD)).targetConsentBy.length > 0, true);
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/accept`, { code: body.code })).status,
    404,
    'the code works once'
  );
  const audit = (await listAudit(D_GUILD, 20)).map((e) => e.action);
  assert.ok(audit.includes('mirror:request') && audit.includes('mirror:agree'));
});

test('the same person with Edit on both servers agrees on both sides at once', async () => {
  await reset();
  const both = await person({ discord: true, fluxer: true });
  const state = await (await both.get(`/guilds/${D_GUILD}/mirror`)).json();
  assert.deepEqual(
    state.candidates.map((c) => c.id),
    [F_KEY],
    'the Fluxer servers this person manages are offered'
  );
  const res = await both.post(`/guilds/${D_GUILD}/mirror/request`, { targetGuildId: F_KEY });
  const body = await res.json();
  assert.equal(body.code, null);
  assert.equal(body.agreed, true);
  assert.equal(body.pair.status, 'ready');
  assert.equal(body.pair.otherName, 'F-main');
});

test('the preview reads, the copy needs a confirmation, and a started copy shows progress and a report', async () => {
  const both = await person({ discord: true, fluxer: true });
  const preview = await (await both.get(`/guilds/${D_GUILD}/mirror/preview`)).json();
  assert.equal(preview.ok, true);
  assert.deepEqual(
    preview.steps.map((s) => s.kind),
    ['guild', 'bridge']
  );
  assert.equal(preview.target.name, 'F-main');
  assert.ok(!('spec' in preview.steps[0]), 'the preview names steps; it does not hand out whole specs');
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'ready', 'a preview changes nothing');

  assert.equal((await both.post(`/guilds/${D_GUILD}/mirror/start`, {})).status, 400);
  assert.equal((await both.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: 'yes' })).status, 400);
  const started = await both.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true });
  assert.equal(started.status, 200);
  const state = await started.json();
  assert.equal(state.pair.status, 'copying');
  assert.equal(state.progress.total, 2);
  assert.equal(state.progress.waiting, 2);
  const report = await (await both.get(`/guilds/${D_GUILD}/mirror/report`)).json();
  assert.deepEqual(
    report.items.map((i) => i.kind),
    ['guild', 'bridge']
  );
  // The options can still be changed; unknown keys are ignored.
  const opts = await both.post(`/guilds/${D_GUILD}/mirror/options`, {
    continuous: false,
    roles: false,
    bogus: 1,
  });
  assert.equal((await opts.json()).pair.options.continuous, false);
});

test('either side can pause, resume and stop; stopping clears the agreement', async () => {
  const bo = await person({ fluxer: true });
  const anna = await person({ discord: true });
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/resume`)).status,
    409,
    'only a paused mirror can be resumed'
  );
  const paused = await bo.post(`/guilds/${F_KEY}/mirror/pause`);
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).pair.status, 'paused');
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/resume`)).status, 200);
  assert.equal((await db.getPairBySource(D_GUILD)).status, 'copying');
  assert.equal(
    (await bo.post(`/guilds/${F_KEY}/mirror/remove`)).status,
    409,
    'a running mirror is stopped before it is removed'
  );
  const stopped = await bo.post(`/guilds/${F_KEY}/mirror/stop`);
  assert.equal((await stopped.json()).pair.status, 'stopped');
  const pair = await db.getPairBySource(D_GUILD);
  assert.deepEqual([pair.sourceConsentBy, pair.targetConsentBy], ['', '']);
  assert.equal(
    (await anna.post(`/guilds/${D_GUILD}/mirror/start`, { confirm: true })).status,
    409,
    'asking again is needed'
  );
  assert.equal((await anna.post(`/guilds/${D_GUILD}/mirror/remove`)).status, 200);
  assert.equal(await db.getPairBySource(D_GUILD), null);
});

test('another server cannot be reached: not by its id, not by a pair, not by a code', async () => {
  await reset();
  const anna = await person({ discord: true }); // Edit on D_GUILD only
  // The admin of D_GUILD has no right in OTHER_D_GUILD or in the Fluxer server.
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
  // The admin of the Fluxer server tries the code on the wrong server and the Discord server.
  const bo = await person({ fluxer: true });
  assert.equal(
    (await bo.post(`/guilds/${D_GUILD}/mirror/accept`, { code })).status,
    403,
    'no right on the Discord server'
  );
  // Someone with Edit on another Fluxer server holds a code for this one: it finds nothing there.
  await db.deletePair((await db.getPairBySource(D_GUILD)).id);
  const other = await db.createPair({
    sourceGuild: OTHER_D_GUILD,
    targetGuild: 'fluxer:900000000000000299',
    status: 'pending',
  });
  assert.ok(other);
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
  const noToken = await own().get(`/api/v2/guilds/${D_GUILD}/mirror/request`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.ok([401, 403].includes(noToken.status));
  assert.equal((await anna.get(`/guilds/${D_GUILD}/mirror`)).status, 200);
});
