// "Signed-in devices" (internal/mobile-api-plan.md, task 5): the account page lists the Sylo app
// sign-ins with name and last use and can revoke each one, in the classic and the V2 dashboard;
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

test('the classic account page lists the devices and escapes their names', async () => {
  const { b } = await person();
  const html = await (await b.get('/account')).text();
  assert.match(html, /Signed-in devices/);
  assert.match(html, /iPhone 18 Pro/);
  assert.match(html, /iPad &lt;Air&gt;/, 'a device name is never raw HTML');
  assert.equal((html.match(/\/account\/devices\/[0-9a-f-]{36}\/revoke/g) ?? []).length, 2);
  assert.doesNotMatch(html, /sylo_[A-Za-z0-9_-]{20,}/, 'no token on the page');
});

test('the classic page revokes one device, and only its own', async () => {
  const { b, phone, pad } = await person();
  const other = await person();
  const theirs = await post(b, `/account/devices/${other.phone.id}/revoke`);
  assert.equal(theirs.status, 302);
  assert.ok(await findApiToken(other.phone.token), "someone else's device is untouched");

  const res = await post(b, `/account/devices/${phone.id}/revoke`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/account?msg=revoked');
  assert.equal(await findApiToken(phone.token), null);
  assert.ok(await findApiToken(pad.token));
});

test('revoking needs the CSRF token from a cookie session', async () => {
  const { b, phone } = await person();
  const res = await b.get(`/account/devices/${phone.id}/revoke`, { method: 'POST' });
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
  for (const path of ['/account/disconnect/fluxer', '/api/v2/account/disconnect/fluxer']) {
    const { b, phone, pad } = await person();
    await signIn(b, 'fluxer', { connect: true });
    const res = await post(b, path);
    assert.ok([200, 302].includes(res.status), `${path} gave ${res.status}`);
    assert.equal(await findApiToken(phone.token), null, path);
    assert.equal(await findApiToken(pad.token), null, path);
  }
});
