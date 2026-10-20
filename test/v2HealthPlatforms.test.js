// The V2 Health page shows every connected bot and the server split per platform, like the
// classic page does ("Sylo#9455 · Sylo#4291", "Discord 13 · Fluxer 3").
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { runtime } = await import('../src/runtime.js');

const fakeClient = (tag, guilds) => ({
  isReady: () => true,
  user: { tag, displayAvatarURL: () => null },
  guilds: { cache: new Map(Array.from({ length: guilds }, (_, i) => [String(i), { memberCount: 1 }])) },
  ws: { ping: 42 },
});

test('/api/v2/health lists each platform and every bot tag', async () => {
  const saved = { ...runtime.clients };
  runtime.clients.discord = fakeClient('Sylo#9455', 13);
  runtime.clients.fluxer = fakeClient('Sylo#4291', 3);
  try {
    const { accountId } = await signInIdentity({
      platform: 'discord',
      platformUserId: '111111111111111111', // OWNER_IDS in oauthApp
      username: 'u',
      avatar: null,
      guildIds: [],
    });
    const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
    const res = await browser().get('/api/v2/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.botTag, 'Sylo#9455 · Sylo#4291');
    assert.deepEqual(
      body.platforms.map((p) => [p.platform, p.guilds, p.tag]),
      [
        ['discord', 13, 'Sylo#9455'],
        ['fluxer', 3, 'Sylo#4291'],
      ]
    );
    assert.equal(body.guildCount, 16);
  } finally {
    runtime.clients.discord = saved.discord;
    runtime.clients.fluxer = saved.fluxer;
  }
});
