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

test('the V2 settings: read and write are for the owner, 403 for an admin', async () => {
  const read = await json(owner, `${V2}/modules/apple-connect/config`);
  assert.equal(read.status, 200);
  assert.equal(read.body.config.channelId, '');
  assert.equal((await json(admin, `${V2}/modules/apple-connect/config`)).status, 403);

  const save = {
    method: 'POST',
    body: {
      channelId: '123456789012345678',
      apps: ['6446998023', '6446998024'],
      events: {
        versionState: { enabled: true },
        build: { enabled: false },
        reviews: { enabled: true, maxStars: 3 },
        feedback: { enabled: true, channelId: '555555555555555555' },
        expiry: { enabled: true, days: 14 },
      },
    },
  };
  assert.equal((await json(admin, `${V2}/modules/apple-connect/config`, save)).status, 403);
  const saved = await json(owner, `${V2}/modules/apple-connect/config`, save);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.channelId, '123456789012345678');
  const { getGuildModule } = await import('../src/db/modules.js');
  const { config: stored } = await getGuildModule(D_GUILD, 'apple-connect');
  assert.deepEqual(stored.apps, ['6446998023', '6446998024']);
  assert.equal(stored.events.reviews.maxStars, 3);
  assert.equal(stored.events.expiry.days, 14);
  assert.equal(stored.events.build.enabled, false, 'an off alert stays off');
  assert.equal(stored.events.feedback.channelId, '555555555555555555', 'a per-alert channel is kept');
});

test('toggling: an admin cannot switch it on, the owner can', async () => {
  const on = { method: 'POST', body: { enabled: true } };
  assert.equal((await json(admin, `${V2}/modules/apple-connect`, on)).status, 403);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), false);
  assert.equal((await json(owner, `${V2}/modules/apple-connect`, on)).status, 200);
  assert.equal(await isModuleEnabled(D_GUILD, 'apple-connect'), true);
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

// Express matches paths case-insensitively and decodes %xx in route params, so the owner check
// has to hold for those spellings too.
test('odd spellings of the module path are refused for an admin', async () => {
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
