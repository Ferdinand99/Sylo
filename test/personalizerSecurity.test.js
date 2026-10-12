import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runtime } from '../src/runtime.js';
process.env.DISCORD_CLIENT_SECRET = 'test-personalizer-secret';
process.env.OWNER_IDS = '960000000000000001';
const { default: settings } = await import('../src/web/routes/settings.js');
const { default: v2 } = await import('../src/web/routes/v2Api.js');
const { csrf } = await import('../src/web/middleware/csrf.js');
const { personalizerHistory } = await import('../src/web/lib/personalizerAudit.js');
const { getPresenceConfig } = await import('../src/db/appSettings.js');
let base, server;
const calls = [];
const ownerId = '960000000000000001',
  otherId = '960000000000000002';
test.before(async () => {
  const user = {
    id: '960000000000000003',
    username: 'Bot',
    tag: 'Bot#1234',
    displayAvatarURL: () => 'https://example.invalid/avatar.png',
    setUsername: async (name) => {
      calls.push('username');
      user.username = name;
    },
    setAvatar: async () => {
      calls.push('avatar');
    },
    setBanner: async () => {
      calls.push('banner');
    },
    setPresence: () => {
      calls.push('presence');
    },
  };
  runtime.client = { user, guilds: { cache: new Map() } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      user: { id: req.get('x-test-user') || otherId },
      guilds: ['960000000000000099'],
      csrf: 'test-csrf',
    };
    res.render = (view, data) => res.json({ view, ...data });
    next();
  });
  app.use(csrf);
  app.use('/settings', settings);
  app.use('/api/v2', v2);
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
  runtime.client = null;
});
function request(path, user = otherId, body, token = 'test-csrf') {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-csrf-token': token },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
}
test('non-operators cannot view or edit identity, presence or audit through either dashboard', async () => {
  for (const path of [
    '/settings',
    '/api/v2/personalizer',
    '/api/v2/personalizer/presence',
    '/api/v2/personalizer/history',
  ])
    assert.equal((await request(path)).status, 403, path);
  for (const path of [
    '/settings/identity',
    '/settings/presence',
    '/api/v2/personalizer/identity',
    '/api/v2/personalizer/presence',
  ])
    assert.equal(
      (
        await request(path, otherId, {
          avatarUrl: 'https://example.invalid/a.png',
          username: 'Hijacked',
          text: 'Hijacked',
        })
      ).status,
      403,
      path
    );
  assert.deepEqual(calls, []);
  assert.deepEqual(await personalizerHistory(), []);
});
test('owner identity updates are attributed to a Discord ID without storing supplied URLs', async () => {
  const res = await request('/settings/identity', ownerId, {
    username: 'Safe Bot',
    avatarUrl: 'https://example.invalid/a.png?secret-url-key=hidden',
  });
  assert.equal(res.status, 302);
  const history = await personalizerHistory();
  assert.equal(history.length, 2);
  assert.ok(history.every((entry) => entry.actor === ownerId));
  assert.equal(history[0].label, 'Wynik zmiany');
  assert.match(history[0].detail, /Awatar/);
  assert.match(history[0].detail, /Bot → Safe Bot/);
  assert.doesNotMatch(JSON.stringify(history), /secret-url-key/);
});
test('V2 identity and both presence routes have the same audit attribution', async () => {
  assert.equal(
    (
      await request('/api/v2/personalizer/identity', ownerId, {
        bannerUrl: 'https://example.invalid/banner.png',
      })
    ).status,
    200
  );
  assert.equal(
    (await request('/settings/presence', ownerId, { status: 'online', type: 'Custom', text: 'Test' })).status,
    302
  );
  assert.equal(
    (
      await request('/api/v2/personalizer/presence', ownerId, {
        status: 'idle',
        type: 'Custom',
        text: 'Updated',
      })
    ).status,
    200
  );
  assert.equal((await getPresenceConfig()).text, 'Updated');
  const history = await personalizerHistory();
  assert.equal(history.length, 8);
  assert.ok(history.every((entry) => entry.actor === ownerId));
  assert.match(history[0].detail, /Status i aktywność/);
});
test('partial identity failures are recorded and CSRF rejection cannot change the bot', async () => {
  const before = calls.length;
  assert.equal((await request('/settings/identity', ownerId, { username: 'Blocked' }, 'wrong')).status, 403);
  assert.equal(calls.length, before);
  assert.equal(
    (await request('/api/v2/personalizer/identity', ownerId, { avatarUrl: 'http://not-https.invalid' }))
      .status,
    200
  );
  assert.match((await personalizerHistory())[0].detail, /Nie udało się: Awatar/);
});
test('owner can read the history in both panels', async () => {
  const html = await request('/settings', ownerId);
  assert.equal(html.status, 200);
  assert.equal((await html.json()).history.length, 10);
  const api = await request('/api/v2/personalizer/history', ownerId);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).history.length, 10);
});
