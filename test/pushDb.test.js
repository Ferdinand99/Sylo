// Storage for push notifications (internal/push-notifications-plan.md, task 1): the push columns
// on an app token's row (so revoking the device ends its notifications), and the hosted relay's
// registrations, stored like app tokens: only a SHA-256 of the relay token.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepare } from '../src/db/driver.js';
import {
  createApiToken,
  revokeApiToken,
  revokeApiTokenValue,
  revokeAccountTokens,
  purgeExpiredApiTokens,
  onApiTokensDeleted,
  apiTokenPush,
  setApiTokenPush,
  clearApiTokenPush,
  setApiTokenPushMuted,
  pushRecipientTokens,
} from '../src/db/apiTokens.js';
import { markApiTokenPigeonProven } from '../src/db/apiTokens.js';
import {
  createRelayRegistration,
  findRelayRegistration,
  touchRelayRegistration,
  deleteRelayRegistration,
  purgeStaleRelayRegistrations,
} from '../src/db/pushRelay.js';

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const account = () => `push-acct-${++n}`;
const device = (c = 'a') => c.repeat(64);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const ORIGIN = 'https://sylo.example.com';

async function token(accountId = account()) {
  const { id } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  return { id, accountId };
}

test('a new token has no push set up and no muted servers', async () => {
  const { id } = await token();
  assert.deepEqual(await apiTokenPush(id), {
    enabled: false,
    deviceToken: null,
    relayToken: null,
    pigeonHandle: null,
    pigeonProvenAt: null,
    environment: null,
    origin: null,
    mutedServers: [],
    devLog: 'errors', // an operator's device hears about errors until it chooses otherwise
  });
  assert.equal(await apiTokenPush('no-such-token'), null);
});

test('setApiTokenPush stores a device token (direct) and replaces on re-register', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { deviceToken: device('a'), environment: 'development', origin: ORIGIN });
  let push = await apiTokenPush(id);
  assert.equal(push.enabled, true);
  assert.equal(push.deviceToken, device('a'));
  assert.equal(push.relayToken, null);
  assert.equal(push.environment, 'development');
  assert.equal(push.origin, ORIGIN);

  await setApiTokenPush(id, { relayToken: 'relay-1', environment: 'production', origin: ORIGIN });
  push = await apiTokenPush(id);
  assert.equal(push.deviceToken, null, 'relay mode keeps no device token');
  assert.equal(push.relayToken, 'relay-1');
  assert.equal(push.environment, 'production');
});

test('a device token lives on one row: registering it elsewhere takes it off the other', async () => {
  const first = await token();
  const second = await token();
  await setApiTokenPush(first.id, { deviceToken: device('b'), environment: 'production', origin: ORIGIN });
  await setApiTokenPush(second.id, { deviceToken: device('b'), environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(first.id)).enabled, false);
  assert.equal((await apiTokenPush(second.id)).enabled, true);
});

test('clearApiTokenPush turns push off but keeps the muted servers', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { deviceToken: device('c'), environment: 'production', origin: ORIGIN });
  await setApiTokenPushMuted(id, '900000000000000001', true);
  await clearApiTokenPush(id);
  const push = await apiTokenPush(id);
  assert.equal(push.enabled, false);
  assert.equal(push.deviceToken, null);
  assert.equal(push.environment, null);
  assert.deepEqual(push.mutedServers, ['900000000000000001']);
});

test('clearApiTokenPush with an expected token leaves a newer registration alone', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { relayToken: 'relay-new', environment: 'production', origin: ORIGIN });
  await clearApiTokenPush(id, { relayToken: 'relay-old' });
  assert.equal((await apiTokenPush(id)).relayToken, 'relay-new');
  await clearApiTokenPush(id, { relayToken: 'relay-new' });
  assert.equal((await apiTokenPush(id)).enabled, false);
});

test('setApiTokenPushMuted adds and removes a server once, and returns the list', async () => {
  const { id } = await token();
  assert.deepEqual(await setApiTokenPushMuted(id, 'fluxer:900000000000000002', true), [
    'fluxer:900000000000000002',
  ]);
  assert.deepEqual(await setApiTokenPushMuted(id, 'fluxer:900000000000000002', true), [
    'fluxer:900000000000000002',
  ]);
  await setApiTokenPushMuted(id, '900000000000000003', true);
  assert.deepEqual(await setApiTokenPushMuted(id, 'fluxer:900000000000000002', false), [
    '900000000000000003',
  ]);
  assert.deepEqual((await apiTokenPush(id)).mutedServers, ['900000000000000003']);
});

test('pushRecipientTokens lists live tokens with push set up, never revoked or expired ones', async () => {
  const on = await token();
  const off = await token();
  const revoked = await token();
  const expired = await token();
  await setApiTokenPush(on.id, { deviceToken: device('d'), environment: 'production', origin: ORIGIN });
  await setApiTokenPush(revoked.id, { relayToken: 'relay-r', environment: 'production', origin: ORIGIN });
  await setApiTokenPush(expired.id, { relayToken: 'relay-e', environment: 'production', origin: ORIGIN });
  await revokeApiToken(revoked.accountId, revoked.id);
  await prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);

  const ids = (await pushRecipientTokens()).map((r) => r.id);
  assert.ok(ids.includes(on.id));
  assert.ok(!ids.includes(off.id));
  assert.ok(!ids.includes(revoked.id));
  assert.ok(!ids.includes(expired.id));
  const row = (await pushRecipientTokens()).find((r) => r.id === on.id);
  assert.equal(row.accountId, on.accountId);
  assert.equal(row.deviceToken, device('d'));
  assert.deepEqual(row.mutedServers, []);
});

// --- Postal Pigeon handles ---------------------------------------------------------------

const handle = (c = 'a') => `hrh_${c.repeat(40)}`;

test('setApiTokenPush stores a Pigeon handle, and each setup replaces the others', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { pigeonHandle: handle('a'), environment: 'production', origin: ORIGIN });
  let push = await apiTokenPush(id);
  assert.equal(push.enabled, true);
  assert.equal(push.pigeonHandle, handle('a'));
  assert.equal(push.pigeonProvenAt, null, 'not accepted by Pigeon yet');
  assert.equal(push.deviceToken, null);
  assert.equal(push.relayToken, null);

  await setApiTokenPush(id, { deviceToken: device('a'), environment: 'production', origin: ORIGIN });
  push = await apiTokenPush(id);
  assert.equal(push.pigeonHandle, null, 'registering the older way drops the handle');
  assert.equal(push.deviceToken, device('a'));

  await setApiTokenPush(id, { pigeonHandle: handle('b'), environment: 'production', origin: ORIGIN });
  push = await apiTokenPush(id);
  assert.equal(push.deviceToken, null, 'and a handle drops the device token');
  assert.equal(push.pigeonHandle, handle('b'));

  await setApiTokenPush(id, { relayToken: 'relay-p', environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(id)).pigeonHandle, null);
});

test('a handle is proven once Pigeon accepted it; the same handle stays proven, a new one does not', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { pigeonHandle: handle('c'), environment: 'production', origin: ORIGIN });
  await markApiTokenPigeonProven(id, 'hrh_not-this-one', 1000);
  assert.equal((await apiTokenPush(id)).pigeonProvenAt, null, 'only for the handle it has');
  await markApiTokenPigeonProven(id, handle('c'), 1234);
  assert.equal((await apiTokenPush(id)).pigeonProvenAt, 1234);
  await markApiTokenPigeonProven(id, handle('c'), 9999);
  assert.equal((await apiTokenPush(id)).pigeonProvenAt, 1234, 'the first time stays');

  // The app registers again on every launch: the same handle keeps its mark.
  await setApiTokenPush(id, { pigeonHandle: handle('c'), environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(id)).pigeonProvenAt, 1234);
  await setApiTokenPush(id, { pigeonHandle: handle('d'), environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(id)).pigeonProvenAt, null, 'a new handle starts unproven');
});

test('a handle lives on one row: registering it elsewhere takes it off the other', async () => {
  const first = await token();
  const second = await token();
  await setApiTokenPush(first.id, { pigeonHandle: handle('e'), environment: 'production', origin: ORIGIN });
  await markApiTokenPigeonProven(first.id, handle('e'));
  await setApiTokenPush(second.id, { pigeonHandle: handle('e'), environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(first.id)).enabled, false);
  assert.equal((await apiTokenPush(first.id)).pigeonProvenAt, null);
  const now = await apiTokenPush(second.id);
  assert.equal(now.pigeonHandle, handle('e'));
  assert.equal(now.pigeonProvenAt, null, 'the mark does not move with it');
});

test('clearApiTokenPush clears the handle; with an expected handle only while it is still the one', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { pigeonHandle: handle('f'), environment: 'production', origin: ORIGIN });
  await markApiTokenPigeonProven(id, handle('f'));
  await clearApiTokenPush(id, { pigeonHandle: handle('old') });
  assert.equal(
    (await apiTokenPush(id)).pigeonHandle,
    handle('f'),
    'an old handle going away is not this one'
  );
  await clearApiTokenPush(id, { deviceToken: device('z') });
  assert.equal((await apiTokenPush(id)).pigeonHandle, handle('f'), 'nor is a device token going away');
  await clearApiTokenPush(id, { pigeonHandle: handle('f') });
  const push = await apiTokenPush(id);
  assert.equal(push.enabled, false);
  assert.equal(push.pigeonHandle, null);
  assert.equal(push.pigeonProvenAt, null);
  assert.equal(push.origin, null);

  await setApiTokenPush(id, { pigeonHandle: handle('g'), environment: 'production', origin: ORIGIN });
  await clearApiTokenPush(id);
  assert.equal((await apiTokenPush(id)).pigeonHandle, null);
});

test('a device token going away leaves a Pigeon handle alone, and the other way round', async () => {
  const { id } = await token();
  await setApiTokenPush(id, { deviceToken: device('h'), environment: 'production', origin: ORIGIN });
  await clearApiTokenPush(id, { pigeonHandle: handle('h') });
  assert.equal((await apiTokenPush(id)).deviceToken, device('h'));
});

test('pushRecipientTokens lists a token that has only a Pigeon handle, with its proven mark', async () => {
  const { id, accountId } = await token();
  await setApiTokenPush(id, { pigeonHandle: handle('i'), environment: 'development', origin: ORIGIN });
  let row = (await pushRecipientTokens()).find((r) => r.id === id);
  assert.equal(row.accountId, accountId);
  assert.equal(row.pigeonHandle, handle('i'));
  assert.equal(row.pigeonProvenAt, null);
  await markApiTokenPigeonProven(id, handle('i'), 4321);
  row = (await pushRecipientTokens()).find((r) => r.id === id);
  assert.equal(row.pigeonProvenAt, 4321);
});

// --- relay registrations -----------------------------------------------------------------

test('createRelayRegistration: a 32-byte base64url token, stored only as its SHA-256', async () => {
  const relayToken = await createRelayRegistration({
    deviceToken: device('e'),
    environment: 'production',
    instance: ORIGIN,
  });
  assert.match(relayToken, /^[A-Za-z0-9_-]{43}$/);
  const rows = await prepare('SELECT * FROM push_relay_registrations WHERE token_hash = ?').all(
    sha256(relayToken)
  );
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes(relayToken));

  const reg = await findRelayRegistration(relayToken);
  assert.equal(reg.deviceToken, device('e'));
  assert.equal(reg.environment, 'production');
  assert.equal(reg.instance, ORIGIN);
  assert.equal(await findRelayRegistration('nope'), null);
  assert.equal(await findRelayRegistration(null), null);
});

test('re-registering a device for the same instance replaces the old registration', async () => {
  const old = await createRelayRegistration({
    deviceToken: device('f'),
    environment: 'production',
    instance: ORIGIN,
  });
  const other = await createRelayRegistration({
    deviceToken: device('f'),
    environment: 'production',
    instance: 'https://other.example.com',
  });
  const fresh = await createRelayRegistration({
    deviceToken: device('f'),
    environment: 'production',
    instance: ORIGIN,
  });
  assert.equal(await findRelayRegistration(old), null);
  assert.ok(await findRelayRegistration(fresh));
  assert.ok(await findRelayRegistration(other), 'another instance keeps its own');
});

test('deleteRelayRegistration forgets a registration', async () => {
  const gone = await createRelayRegistration({
    deviceToken: device('1'),
    environment: 'production',
    instance: ORIGIN,
  });
  assert.equal(await deleteRelayRegistration(gone), true);
  assert.equal(await deleteRelayRegistration(gone), false);
  assert.equal(await findRelayRegistration(gone), null);
});

test('purge: never used after 7 days, used ones after 90 days without a send', async () => {
  const reg = async (c) =>
    createRelayRegistration({ deviceToken: device(c), environment: 'production', instance: ORIGIN });
  const now = Date.now();
  const age = (relayToken, { created, used }) =>
    prepare('UPDATE push_relay_registrations SET created_at = ?, last_used_at = ? WHERE token_hash = ?').run(
      created,
      used,
      sha256(relayToken)
    );
  const neverUsedOld = await reg('2');
  const neverUsedNew = await reg('3');
  const usedRecently = await reg('4');
  const usedLongAgo = await reg('5');
  await age(neverUsedOld, { created: now - 8 * DAY, used: now - 8 * DAY });
  await age(neverUsedNew, { created: now - 6 * DAY, used: now - 6 * DAY });
  assert.equal((await findRelayRegistration(neverUsedNew)).sentAt, null, 'no send yet');
  await touchRelayRegistration((await findRelayRegistration(usedRecently)).id, now - 89 * DAY);
  await touchRelayRegistration((await findRelayRegistration(usedLongAgo)).id, now - 91 * DAY);
  await age(usedRecently, { created: now - 100 * DAY, used: now - 89 * DAY });
  assert.equal((await findRelayRegistration(usedRecently)).sentAt, now - 89 * DAY);

  assert.ok((await purgeStaleRelayRegistrations({ now })) >= 2);
  assert.equal(await findRelayRegistration(neverUsedOld), null);
  assert.ok(await findRelayRegistration(neverUsedNew));
  assert.ok(await findRelayRegistration(usedRecently));
  assert.equal(await findRelayRegistration(usedLongAgo), null);
});

test('a device token keeps at most 10 registrations: the oldest goes', async () => {
  const deviceToken = device('9');
  const register = (i) =>
    createRelayRegistration({
      deviceToken,
      environment: 'production',
      instance: `https://i${i}.example.com`,
    });
  const oldest = await register(0);
  await prepare('UPDATE push_relay_registrations SET created_at = ? WHERE token_hash = ?').run(
    Date.now() - DAY,
    sha256(oldest)
  );
  const rest = [];
  for (let i = 1; i <= 10; i += 1) rest.push(await register(i));
  const { n } = await prepare(
    'SELECT COUNT(*) AS n FROM push_relay_registrations WHERE device_token = ?'
  ).get(deviceToken);
  assert.equal(Number(n), 10);
  assert.equal(await findRelayRegistration(oldest), null);
  assert.ok(await findRelayRegistration(rest.at(-1)), 'the newest always stays');
});

test('deleting token rows reports their relay tokens, however they are deleted', async () => {
  const seen = [];
  onApiTokensDeleted((relayTokens) => seen.push(...relayTokens));
  const withRelay = async (accountId, relayToken) => {
    const t = await token(accountId);
    await setApiTokenPush(t.id, { relayToken, environment: 'production', origin: ORIGIN });
    return t;
  };

  const one = await withRelay(account(), 'relay-revoke');
  await revokeApiToken(one.accountId, one.id);
  const acct = account();
  await withRelay(acct, 'relay-all-1');
  await withRelay(acct, 'relay-all-2');
  await revokeAccountTokens(acct);
  const byValue = account();
  const { id, token: value } = await createApiToken(byValue, { deviceName: 'iPhone', ttlMs: DAY });
  await setApiTokenPush(id, { relayToken: 'relay-value', environment: 'production', origin: ORIGIN });
  await revokeApiTokenValue(value);
  const expired = await withRelay(account(), 'relay-expired');
  await prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
  await purgeExpiredApiTokens();
  // Past 20 tokens, the least recently used one is signed out.
  const busy = account();
  const first = await withRelay(busy, 'relay-trimmed');
  await prepare('UPDATE api_tokens SET last_used_at = 0 WHERE id = ?').run(first.id);
  for (let i = 0; i < 20; i += 1) await token(busy);
  await token(account()); // a token without push reports nothing

  // (An expired token from an earlier test in this file is purged here too.)
  const mine = seen.filter((t) => t.startsWith('relay-') && t !== 'relay-e');
  assert.deepEqual(mine.sort(), [
    'relay-all-1',
    'relay-all-2',
    'relay-expired',
    'relay-revoke',
    'relay-trimmed',
    'relay-value',
  ]);
});

test('a relay token lives on one row too', async () => {
  const first = await token();
  const second = await token();
  await setApiTokenPush(first.id, { relayToken: 'relay-shared', environment: 'production', origin: ORIGIN });
  await setApiTokenPush(second.id, { relayToken: 'relay-shared', environment: 'production', origin: ORIGIN });
  assert.equal((await apiTokenPush(first.id)).enabled, false);
  assert.equal((await apiTokenPush(second.id)).relayToken, 'relay-shared');
});
