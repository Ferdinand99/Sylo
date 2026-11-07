// "Signed-in devices" (internal/mobile-api-plan.md, task 5): the account page lists the Sylo app
// sign-ins with name and last use and can revoke each one;
// disconnecting a sign-in revokes every app token of the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken, findApiToken } = await import('../src/db/apiTokens.js');

const DAY = 24 * 60 * 60 * 1000;

/** A fresh person signed in on the web, with two app tokens. */
async function person() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const phone = await createApiToken(accountId, { deviceName: 'iPhone 18 Pro', ttlMs: DAY });
  const pad = await createApiToken(accountId, { deviceName: 'iPad <Air>', ttlMs: DAY });
  return { b, accountId, phone, pad };
}

const csrfOf = async (b) => (await (await b.get('/api/v2/csrf')).json()).token;
const post = async (b, path, body) =>
  b.get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfOf(b) },
    body: JSON.stringify(body ?? {}),
  });

test('revoking needs the CSRF token from a cookie session', async () => {
  const { b, phone } = await person();
  const res = await b.get(`/api/v2/account/devices/${phone.id}/revoke`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.ok(await findApiToken(phone.token));
});

test('V2: the account lists devices without secrets, and marks the one asking', async () => {
  const { b, phone } = await person();
  const web = await (await b.get('/api/v2/account')).json();
  assert.deepEqual(web.devices.map((d) => d.deviceName).sort(), ['iPad <Air>', 'iPhone 18 Pro']);
  for (const d of web.devices) {
    assert.deepEqual(Object.keys(d).sort(), ['createdAt', 'current', 'deviceName', 'id', 'lastUsedAt']);
    assert.equal(d.current, false);
  }
  const app = browser();
  const fromApp = await (
    await app.get('/api/v2/account', { headers: { authorization: `Bearer ${phone.token}` } })
  ).json();
  assert.deepEqual(
    fromApp.devices.filter((d) => d.current).map((d) => d.id),
    [phone.id]
  );
});

test('V2: revoke a device from the web, or from the app itself', async () => {
  const { b, phone, pad } = await person();
  const res = await post(b, `/api/v2/account/devices/${pad.id}/revoke`);
  assert.equal(res.status, 200);
  assert.equal(await findApiToken(pad.token), null);

  const other = await person();
  const theirs = await post(b, `/api/v2/account/devices/${other.pad.id}/revoke`);
  assert.equal(theirs.status, 404);
  assert.ok(await findApiToken(other.pad.token));

  const app = browser();
  const self = await app.get(`/api/v2/account/devices/${phone.id}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phone.token}` },
  });
  assert.equal(self.status, 200);
  assert.equal(await findApiToken(phone.token), null);
});

test('disconnecting a sign-in revokes every app token of the account', async () => {
  for (const path of ['/api/v2/account/disconnect/fluxer']) {
    const { b, phone, pad } = await person();
    await signIn(b, 'fluxer', { connect: true });
    const res = await post(b, path);
    assert.equal(res.status, 200, `${path} gave ${res.status}`);
    assert.equal(await findApiToken(phone.token), null, path);
    assert.equal(await findApiToken(pad.token), null, path);
  }
});
