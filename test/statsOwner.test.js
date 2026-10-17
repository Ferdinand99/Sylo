// Game-stats lookups are one cache for the whole instance: who looked up which player, from any
// server. Only the operators see that list; a server admin's game-stats page does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

test('/stats is for operators only', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.equal((await b.get('/stats', { headers: { accept: 'text/html' } })).status, 403);
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
