// A signed-in person can delete their dashboard account themselves (also from the Sylo app,
// which App Store review requires): the sign-ins, sessions and app tokens go, and the cookie
// no longer works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');

async function signedIn() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const csrf = (await (await b.get('/api/v2/csrf')).json()).token;
  return { b, csrf, id: profiles.discord.id };
}

test('the V2 API deletes the account after a confirmation, and the cookie stops working', async () => {
  const { b, csrf, id } = await signedIn();
  const post = (body) =>
    b.get('/api/v2/account/delete', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({})).status, 400, 'needs confirm: true');
  assert.ok(await findIdentity('discord', id), 'nothing happens without the confirmation');

  assert.equal((await post({ confirm: true })).status, 200);
  assert.equal(await findIdentity('discord', id), null);
  assert.notEqual((await b.get('/api/v2/guilds')).status, 200, 'the old cookie is signed out');
});

test('the V2 API deletes the account, also with an app token', async () => {
  const { id } = await signedIn();
  const { accountId } = await findIdentity('discord', id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  const app = browser();
  const call = (body) =>
    app.get('/api/v2/account/delete', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await call({})).status, 400, 'needs confirm: true');
  assert.equal((await call({ confirm: true })).status, 200);
  assert.equal(await findIdentity('discord', id), null);
  assert.equal((await call({ confirm: true })).status, 401, 'the token is gone too');
});
