// The rate limits of adding a login from the app: a code is asked for at most 10 times a minute per
// app token, and the browser pages open at most 10 times a minute per client. Its own file, so the
// counts of the other tests (every request from this machine) are not spent here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');

async function token() {
  setProfiles();
  await signIn(browser(), 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  return (await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 })).token;
}

const app = browser();
const issue = (t) =>
  app.get('/api/mobile/connect/fluxer', { method: 'POST', headers: { authorization: `Bearer ${t}` } });

test('the 11th code in a minute is a JSON 429, and another token has its own count', async () => {
  const mine = await token();
  const other = await token();
  for (let i = 0; i < 10; i++) assert.equal((await issue(mine)).status, 200, `call ${i + 1}`);
  const limited = await issue(mine);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('content-type'), /json/);
  assert.ok(limited.headers.get('retry-after'));
  assert.equal((await issue(other)).status, 200, 'a different device is not held back');
});

test('the 11th visit to the connect page in a minute is refused, and no guess gets through', async () => {
  const sheet = browser();
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const res = await sheet.get(`/auth/mobile/connect?code=${'A'.repeat(43)}`);
    codes.push(res.status);
  }
  assert.deepEqual(codes, Array(10).fill(400), 'a wrong code is just refused');
  const limited = await sheet.get(`/auth/mobile/connect?code=${'B'.repeat(43)}`);
  assert.equal(limited.status, 429);
  const cont = await sheet.get('/auth/mobile/connect/continue?nonce=x');
  assert.equal(cont.status, 429, 'the same count covers the confirmation');
});
