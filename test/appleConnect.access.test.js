// The App Store Connect module belongs to the Sylo owner: a server admin, a moderator or a
// member can neither see, enable, configure nor read it, even with a hand-made request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { isModuleEnabled } = await import('../src/db/modules.js');

const OWNER_ID = '111111111111111111'; // OWNER_IDS in the harness
const owner = browser();
profiles.discord = { id: OWNER_ID, username: 'owner', guilds: [{ id: D_GUILD, owner: true }] };
await signIn(owner, 'discord');
setProfiles(); // a different Discord account that administers the same server
const admin = browser();
await signIn(admin, 'discord');

const json = async (b, path, init = {}) => {
  const token =
    init.method && init.method !== 'GET' ? (await (await b.get('/api/v2/csrf')).json()).token : null;
  const res = await b.get(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { 'x-csrf-token': token, 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const V2 = `/api/v2/guilds/${D_GUILD}`;

test('the module page: the owner gets it, a server admin gets 403', async () => {
  const ok = await owner.get(`/guilds/${D_GUILD}/m/apple-connect`, { headers: { accept: 'text/html' } });
  assert.equal(ok.status, 200);
  const no = await admin.get(`/guilds/${D_GUILD}/m/apple-connect`, { headers: { accept: 'text/html' } });
  assert.equal(no.status, 403);
});

test('the sidebar lists it for the owner only', async () => {
  // The sidebar lists a module once it is switched on.
  await json(owner, `${V2}/modules/apple-connect`, { method: 'POST', body: { enabled: true } });
  const mine = await (
    await owner.get(`/guilds/${D_GUILD}/m/afk`, { headers: { accept: 'text/html' } })
  ).text();
  assert.match(mine, /m\/apple-connect/);
  const theirs = await (
    await admin.get(`/guilds/${D_GUILD}/m/afk`, { headers: { accept: 'text/html' } })
  ).text();
  assert.doesNotMatch(theirs, /apple-connect/);
  await json(owner, `${V2}/modules/apple-connect`, { method: 'POST', body: { enabled: false } });
});

test('the V2 settings: read and write are for the owner, 403 for an admin', async () => {
  const read = await json(owner, `${V2}/modules/apple-connect/config`);
  assert.equal(read.status, 200);
  assert.equal(read.body.config.channelId, '');
  assert.equal((await json(admin, `${V2}/modules/apple-connect/config`)).status, 403);

  const save = { method: 'POST', body: { channelId: '123456789012345678' } };
  assert.equal((await json(admin, `${V2}/modules/apple-connect/config`, save)).status, 403);
  const saved = await json(owner, `${V2}/modules/apple-connect/config`, save);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.channelId, '123456789012345678');
});

test('toggling: an admin cannot switch it on, the owner can', async () => {
  const on = { method: 'POST', body: { enabled: true } };
  assert.equal((await json(admin, `${V2}/modules/apple-connect`, on)).status, 403);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), false);
  assert.equal((await json(owner, `${V2}/modules/apple-connect`, on)).status, 200);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), true);

  // The classic dashboard's toggle is guarded the same way.
  const classic = await admin.get(`/guilds/${D_GUILD}/modules/apple-connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': (await (await admin.get('/api/v2/csrf')).json()).token,
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(classic.status, 403);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), true, 'still on');
});

test('a bulk toggle from an admin skips the owner-only module', async () => {
  await json(owner, `${V2}/modules/apple-connect`, { method: 'POST', body: { enabled: false } });
  const bulk = await json(admin, `${V2}/modules/bulk`, {
    method: 'POST',
    body: { ids: ['afk', 'apple-connect'], enabled: true },
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.count, 1);
  assert.equal(await isModuleEnabled(D_GUILD, 'afk'), true);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), false);
});

test('the overview shows the module card to the owner only', async () => {
  const ids = (body) => body.groups.flatMap((g) => g.cards.map((c) => c.id));
  const mine = await json(owner, `${V2}/overview`);
  assert.ok(ids(mine.body).includes('apple-connect'));
  const theirs = await json(admin, `${V2}/overview`);
  assert.ok(!ids(theirs.body).includes('apple-connect'));
});

test('the classic settings form: saved by the owner, 403 for an admin', async () => {
  const send = async (b) => {
    const csrf = (await (await b.get('/api/v2/csrf')).json()).token;
    return b.get(`/guilds/${D_GUILD}/m/apple-connect/config`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrf,
        'hx-request': 'true',
      },
      body: new URLSearchParams({
        channelId: '123456789012345678',
        apps: '6446998023\n6446998024',
        ev_versionState: 'on',
        ev_feedback: 'on',
        ev_feedback_ch: '555555555555555555',
        ev_reviews: 'on',
        rv_maxStars: '3',
        ex_days: '14',
      }).toString(),
    });
  };
  assert.equal((await send(admin)).status, 403);
  const { getGuildModule } = await import('../src/db/modules.js');
  const before = (await getGuildModule(D_GUILD, 'apple-connect')).config;
  assert.notDeepEqual(before.apps, ['6446998023', '6446998024'], 'the admin changed nothing');

  assert.equal((await send(owner)).status, 200);
  const { config } = await getGuildModule(D_GUILD, 'apple-connect');
  assert.deepEqual(config.apps, ['6446998023', '6446998024']);
  assert.equal(config.events.reviews.maxStars, 3);
  assert.equal(config.events.expiry.days, 14);
  assert.equal(config.events.build.enabled, false, 'an unticked box is off');
  assert.equal(config.events.feedback.channelId, '555555555555555555', 'a per-alert channel is kept');
});

// Express matches paths case-insensitively and decodes %xx in route params, so the owner check
// has to hold for those spellings too.
test('odd spellings of the module path are refused for an admin', async () => {
  const paths = [
    `/guilds/${D_GUILD}/M/apple-connect`,
    `/guilds/${D_GUILD}/m/Apple-Connect`,
    `/guilds/${D_GUILD}/m/apple%2Dconnect`,
    `/guilds/${D_GUILD}/m/apple-connect/`,
    `/guilds/${D_GUILD}/m/%61pple-connect`,
    `/guilds/${D_GUILD}/M/apple-connect/config`,
  ];
  for (const p of paths) {
    const r = await admin.get(p, { headers: { accept: 'text/html' } });
    assert.ok([403, 404].includes(r.status), `${p} gave ${r.status}`);
  }
  const v2 = [
    `${V2}/Modules/apple-connect/config`,
    `${V2}/modules/apple%2Dconnect/config`,
    `${V2}/MODULES/apple-connect/config`,
  ];
  for (const p of v2) {
    const r = await admin.get(p);
    assert.ok([403, 404].includes(r.status), `${p} gave ${r.status}`);
    const body = await r.text();
    assert.doesNotMatch(body, /appleEnabled/, `${p} leaked the settings`);
  }
  const toggle = await json(admin, `${V2}/modules/apple%2Dconnect`, {
    method: 'POST',
    body: { enabled: true },
  });
  assert.ok([403, 404].includes(toggle.status), `encoded toggle gave ${toggle.status}`);
  const upper = await json(admin, `${V2}/Modules/apple-connect`, { method: 'POST', body: { enabled: true } });
  assert.ok([403, 404].includes(upper.status), `upper toggle gave ${upper.status}`);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), false);
});
