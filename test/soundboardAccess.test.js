import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { runtime } from '../src/runtime.js';
process.env.DISCORD_CLIENT_SECRET = 'soundboard-test-secret';
const { default: router } = await import('../src/web/routes/guildSoundboard.js');
const guildId = '950000000000000001',
  userId = '950000000000000002';
let server, base;
let allowed = false;
test.before(async () => {
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          guildId,
          {
            id: guildId,
            members: {
              fetch: async (options) => {
                assert.equal(options.force, true);
                return { permissions: { has: () => allowed }, roles: { cache: { hasAny: () => false } } };
              },
            },
          },
        ],
      ]),
    },
  };
  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { id: userId }, guilds: [guildId] };
    next();
  });
  app.use('/guilds/:guildId/soundboard', router);
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/guilds/${guildId}/soundboard`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
  runtime.client = null;
});
test('an old admin OAuth session cannot bypass revoked server permissions', async () => {
  const res = await fetch(base + '/status');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /aktualnych uprawnień/);
});
test('a current administrator can access playback status', async () => {
  allowed = true;
  const res = await fetch(base + '/status');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { playing: false });
});
