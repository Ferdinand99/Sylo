// Dashboard actions that call the platform's API (test messages, publishing a message or role
// menu, locking every channel) get a stricter limit than the dashboard's general one: 10 a
// minute per server and person, shared by the classic and the new dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { platformActionKey } = await import('../src/web/middleware/rateLimit.js');

/** Signed in as the owner (at sign-in) of both Discord test servers. */
async function signedIn() {
  setProfiles();
  profiles.discord.guilds[1] = { id: OTHER_D_GUILD, owner: true };
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return {
    json: (path, body = {}) =>
      b.get(path, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    form: (path, body = {}) =>
      b.get(path, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      }),
  };
}

test('the 11th platform action within a minute is refused, and only for that server', async () => {
  const { json, form } = await signedIn();
  const testOn = (guildId) => json(`/api/v2/guilds/${guildId}/modules/afk/test`);
  for (let i = 0; i < 10; i += 1) assert.notEqual((await testOn(D_GUILD)).status, 429, `call ${i + 1}`);

  const refused = await testOn(D_GUILD);
  assert.equal(refused.status, 429);
  assert.ok((await refused.json()).error, 'a JSON error on /api');

  assert.notEqual((await testOn(OTHER_D_GUILD)).status, 429, 'another server is unaffected');
  assert.equal(
    (await form(`/guilds/${D_GUILD}/m/afk/test`)).status,
    429,
    'the classic dashboard shares the count'
  );
});

test('every platform action carries the strict limit', async () => {
  const { json, form } = await signedIn();
  const limitOf = async (res) => res.headers.get('x-ratelimit-limit');
  const g = D_GUILD;
  const strict = {
    'V2 module test': () => json(`/api/v2/guilds/${g}/modules/welcome/test`),
    'V2 reminders test': () => json(`/api/v2/guilds/${g}/modules/reminders/test`),
    'V2 message publish': () => json(`/api/v2/guilds/${g}/messages/new`, { action: 'publish' }),
    'V2 role-menu publish': () => json(`/api/v2/guilds/${g}/modules/roles/rr`),
    'V2 lock-all': () => json(`/api/v2/guilds/${g}/moderation/lock-all`),
    'V2 unlock-all': () => json(`/api/v2/guilds/${g}/moderation/unlock-all`),
  };
  for (const [name, call] of Object.entries(strict)) assert.equal(await limitOf(await call()), '10', name);

  // A fresh person for the classic routes: the shared count above is nearly used up.
  const v1 = await signedIn();
  const classic = {
    'V1 module test': () => v1.form(`/guilds/${g}/m/welcome/test`),
    'V1 reminders test': () => v1.form(`/guilds/${g}/m/reminders/r/new`, { action: 'test' }),
    'V1 message publish': () => v1.form(`/guilds/${g}/messages/new`, { action: 'publish' }),
    'V1 role-menu publish': () => v1.form(`/guilds/${g}/m/roles/rr`),
    'V1 lock-all': () => v1.form(`/guilds/${g}/moderation/lock-all`),
    'V1 unlock-all': () => v1.form(`/guilds/${g}/moderation/unlock-all`),
  };
  for (const [name, call] of Object.entries(classic)) assert.equal(await limitOf(await call()), '10', name);

  // Saving a draft or a reminder does not touch the platform and keeps the general limit.
  assert.notEqual(await limitOf(await json(`/api/v2/guilds/${g}/messages/new`, { action: 'save' })), '10');
  assert.notEqual(await limitOf(await form(`/guilds/${g}/m/reminders/r/new`, { action: 'save' })), '10');
});

test('without an account (open mode) the limit is per server and client address', () => {
  const req = (guildId, ip, account) => ({ params: { guildId }, ip, account });
  assert.equal(platformActionKey(req('1', '10.0.0.1')), platformActionKey(req('1', '10.0.0.1')));
  assert.notEqual(platformActionKey(req('1', '10.0.0.1')), platformActionKey(req('2', '10.0.0.1')));
  assert.notEqual(platformActionKey(req('1', '10.0.0.1')), platformActionKey(req('1', '10.0.0.2')));
  assert.equal(
    platformActionKey(req('1', '10.0.0.1', { id: 7 })),
    platformActionKey(req('1', '10.0.0.2', { id: 7 })),
    'a signed-in account is counted wherever it is'
  );
});
