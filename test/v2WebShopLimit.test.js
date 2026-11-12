// Buying in the web shop is rate limited per person and server (15 a minute); the count only starts
// for people who may use the shop. Own file: the app-wide request limit of a test run is shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, setProfiles, startOAuthApp } from './helpers/oauthApp.js';
import { session } from './helpers/v2Guarded.js';
import { fakeMember } from './helpers/fakeShop.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');

test('the 16th purchase attempt of a minute gets a 429, and a stranger is not counted', async () => {
  await setGuildModule(D_GUILD, 'economy', { enabled: true, config: { webShop: true } });
  const ME = '300000000000000999';
  runtime.clients.discord.guilds.cache.get(D_GUILD).members.cache.set(ME, fakeMember(ME));
  setProfiles({ discordId: ME });
  const me = await session({ discordId: ME });
  const statuses = [];
  for (let i = 0; i < 17; i++)
    statuses.push((await me.post(`/shop/${D_GUILD}/buy`, { itemId: 999999 })).status);
  assert.deepEqual(statuses.slice(0, 15), Array(15).fill(400));
  assert.deepEqual(statuses.slice(15), [429, 429]);

  const stranger = await session({ discordId: '300000000000000998' });
  for (let i = 0; i < 17; i++)
    assert.equal((await stranger.post(`/shop/${D_GUILD}/buy`, { itemId: 1 })).status, 404);
});
