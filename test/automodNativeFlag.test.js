// The automod settings answer says whether the server's platform has native AutoMod rules, so
// the Sylo app shows that section only where it works instead of guessing from the server id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, F_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const automod = async (platform, guildId) => {
  setProfiles();
  const b = browser();
  await signIn(b, platform);
  const res = await b.get(`/api/v2/guilds/${guildId}/modules/automod/config`);
  assert.equal(res.status, 200);
  return res.json();
};

test('a Discord server has native AutoMod', async () => {
  assert.equal((await automod('discord', D_GUILD)).nativeAutomod, true);
});

test('a Fluxer community does not', async () => {
  assert.equal((await automod('fluxer', `fluxer:${F_GUILD}`)).nativeAutomod, false);
});
