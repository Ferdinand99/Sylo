// A Sylo with only the Discord login set up has no second login to add: it does not offer
// `app-connect`, and the code route refuses the platform that is not set up.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SYLO_TEST_NO_FLUXER_LOGIN = '1';
const { browser, profiles, setProfiles, signIn, startOAuthApp } = await import('./helpers/oauthApp.js');
await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');

test('no app-connect feature, and no code for the platform that is not set up', async () => {
  const app = browser();
  const info = await (await app.get('/api/mobile/info')).json();
  assert.deepEqual(info.loginProviders, ['discord']);
  assert.ok(!info.features.includes('app-connect'));

  setProfiles();
  await signIn(browser(), 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  const post = (platform) =>
    app.get(`/api/mobile/connect/${platform}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  const fluxer = await post('fluxer');
  assert.equal(fluxer.status, 400);
  assert.deepEqual(await fluxer.json(), { error: 'invalid_platform' });
  assert.equal((await post('discord')).status, 409, 'and the one it has is already there');
});
