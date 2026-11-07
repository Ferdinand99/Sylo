// Game-stats lookups are one cache for the whole instance: who looked up which player, from any
// server. Only the operators see that list; a server admin's game-stats page does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

test('/api/v2/stats is for operators only', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.equal((await b.get('/api/v2/stats')).status, 403);
});

test("a server's game-stats page lists no lookups for a non-operator", async () => {
  const { prepare } = await import('../src/db/driver.js');
  await prepare(
    "INSERT INTO stats_cache (cache_key, game, title, username, platform, payload, created_at) VALUES ('k1', 'bf', 'BF', 'someplayer', 'pc', '{}', ?)"
  ).run(Date.now());
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get(`/api/v2/guilds/${D_GUILD}/modules/game-stats/config`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).recent, []);
});

const seedLookup = async () => {
  const { setCached, cacheKey } = await import('../src/db/cache.js');
  await setCached(
    cacheKey('bf4', 'pc', 'v2player'),
    { game: 'battlefield', title: 'bf4', username: 'v2player', platform: 'pc' },
    { kd: '2.5', winRate: '61%', timePlayed: '120h' }
  );
};

test('/api/v2/stats lists the cached lookups for an operator', async () => {
  await seedLookup();
  setProfiles({ discordId: '111111111111111111' }); // OWNER_IDS in helpers/oauthApp.js
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get('/api/v2/stats');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ttlMinutes, 'number');
  assert.ok(body.rows.length <= 50);
  const row = body.rows.find((r) => r.username === 'v2player');
  assert.deepEqual(Object.keys(row).sort(), [
    'ago',
    'fresh',
    'game',
    'kd',
    'platform',
    'timePlayed',
    'title',
    'username',
    'winRate',
  ]);
  assert.equal(row.game, 'battlefield');
  assert.equal(row.title, 'bf4');
  assert.equal(row.platform, 'pc');
  assert.equal(row.kd, '2.5');
  assert.equal(row.winRate, '61%');
  assert.equal(row.timePlayed, '120h');
  assert.equal(row.fresh, true);
  assert.equal(typeof row.ago, 'string');
});

test('/api/v2/stats is refused for a non-operator', async () => {
  await seedLookup();
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get('/api/v2/stats');
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /v2player/);
});

test("a server's game-stats form tells an operator they may open the full cache view", async () => {
  for (const [discordId, expected] of [
    ['111111111111111111', true],
    [undefined, false],
  ]) {
    setProfiles({ discordId });
    const b = browser();
    await signIn(b, 'discord');
    const res = await b.get(`/api/v2/guilds/${D_GUILD}/modules/game-stats/config`);
    assert.equal((await res.json()).operator, expected);
  }
});
