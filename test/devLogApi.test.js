// The Sylo app's Health page and dev-log settings: the stored dev log and Health are for
// operators only (not people who only run a server), the account says whether you are one, and
// each device sets which dev-log events it is notified about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, setApiTokenPush } = await import('../src/db/apiTokens.js');
const { addDevLogEntry } = await import('../src/db/devLogEntries.js');
const { configurePush } = await import('../src/lib/push.js');

configurePush({ apns: { send: async () => ({ status: 'ok' }) }, relayUrl: null });

async function tokenFor(platformUserId) {
  const { accountId } = await signInIdentity({
    platform: 'discord',
    platformUserId,
    username: 'u',
    avatar: null,
    guildIds: [],
  });
  const { id, token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  await setApiTokenPush(id, {
    deviceToken: 'b'.repeat(64),
    environment: 'production',
    origin: 'https://s.test',
  });
  return token;
}

const OPERATOR = await tokenFor('111111111111111111');
const ADMIN = await tokenFor(uid('3333333333'));
const call = (token, path, init = {}) =>
  browser().get(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

test('the dev log is for operators only', async () => {
  await addDevLogEntry({ level: 'error', scope: 'db', message: 'connection lost', at: Date.now() });
  await addDevLogEntry({ level: 'warn', scope: 'push', message: 'relay slow', at: Date.now() + 1 });
  const res = await call(OPERATOR, '/api/v2/dev-log?limit=10');
  assert.equal(res.status, 200);
  const { entries } = await res.json();
  assert.deepEqual(
    entries.slice(0, 2).map((e) => e.scope),
    ['push', 'db']
  );
  const errors = (await (await call(OPERATOR, '/api/v2/dev-log?level=error')).json()).entries;
  assert.ok(errors.every((e) => e.level === 'error'));
  assert.equal((await call(ADMIN, '/api/v2/dev-log')).status, 403);
  assert.equal((await call(ADMIN, '/api/v2/health')).status, 403);
  assert.equal((await call(OPERATOR, '/api/v2/health')).status, 200);
});

test('the account says whether you are an operator', async () => {
  assert.equal((await (await call(OPERATOR, '/api/v2/account')).json()).operator, true);
  assert.equal((await (await call(ADMIN, '/api/v2/account')).json()).operator, false);
});

test('a device reads and sets its dev-log level; only an operator can', async () => {
  const before = await (await call(OPERATOR, '/api/mobile/push')).json();
  assert.equal(before.devLog, 'errors');
  const put = (token, level) =>
    call(token, '/api/mobile/push/dev-log', { method: 'PUT', body: JSON.stringify({ level }) });
  assert.equal((await put(OPERATOR, 'warnings')).status, 200);
  assert.equal((await (await call(OPERATOR, '/api/mobile/push')).json()).devLog, 'warnings');
  assert.equal((await put(OPERATOR, 'loud')).status, 400);
  assert.equal((await put(ADMIN, 'warnings')).status, 403);
});
