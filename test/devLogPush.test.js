// Dev-log notifications for the Sylo app: Sylo's own errors and warnings go to the devices of
// its operators (OWNER_IDS / FLUXER_OWNER_IDS) and nobody else, at the level each device chose
// (off, errors, or errors and warnings), and the relay accepts them as well as tickets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, setApiTokenPush, setApiTokenDevLog, apiTokenPush } =
  await import('../src/db/apiTokens.js');
const { configurePush, resetPushState, notifyDevLogEvent, devLogNotification } =
  await import('../src/lib/push.js');
const { validNotification } = await import('../src/web/routes/pushRelay.js');

const ORIGIN = 'https://sylo.example.com';
const OPERATOR = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js
let seq = 0;

async function device(platformUserId, level) {
  const { accountId } = await signInIdentity({
    platform: 'discord',
    platformUserId,
    username: 'u',
    avatar: null,
    guildIds: [],
  });
  const { id } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  await setApiTokenPush(id, {
    deviceToken: (++seq).toString(16).padStart(64, 'a'),
    environment: 'production',
    origin: ORIGIN,
  });
  if (level) await setApiTokenDevLog(id, level);
  return id;
}

const sent = [];
configurePush({
  apns: { send: async () => ({ status: 'ok' }) },
  relayUrl: null,
  deliver: async (r, n) => {
    sent.push({ id: r.id, n });
    return 'ok';
  },
});

test.beforeEach(() => {
  sent.length = 0;
  resetPushState();
});

test('only operators get dev-log notifications, at the level they chose', async () => {
  const errorsOnly = await device(OPERATOR); // default: errors
  const nonOperator = await device(uid('3333333333'), 'warnings');

  await notifyDevLogEvent({ level: 'error', scope: 'db', message: 'connection lost', at: Date.now() });
  assert.deepEqual(
    sent.map((s) => s.id),
    [errorsOnly]
  );
  assert.equal(sent[0].n.data.kind, 'devlog');
  assert.equal(sent[0].n.data.server, ORIGIN);

  sent.length = 0;
  await notifyDevLogEvent({ level: 'warn', scope: 'push', message: 'relay slow', at: Date.now() });
  assert.deepEqual(sent, [], 'a warning does not reach an errors-only device');
  assert.ok(!sent.some((s) => s.id === nonOperator));
});

test('warnings reach a device that chose them; off means nothing', async () => {
  const OP2 = '555555555555555555'; // FLUXER_OWNER_IDS, but signed in on Discord: not an operator
  const both = await device(OPERATOR, 'warnings');
  const off = await device(OPERATOR, 'off');
  const lookalike = await device(OP2, 'warnings');
  await notifyDevLogEvent({ level: 'warn', scope: 'push', message: 'relay slow', at: Date.now() });
  const ids = sent.map((s) => s.id);
  assert.ok(ids.includes(both));
  assert.ok(!ids.includes(off));
  assert.ok(!ids.includes(lookalike), 'operator lists are per platform');
});

test('the device setting is stored and read back', async () => {
  const id = await device(OPERATOR);
  assert.equal((await apiTokenPush(id)).devLog, 'errors');
  await setApiTokenDevLog(id, 'warnings');
  assert.equal((await apiTokenPush(id)).devLog, 'warnings');
  await assert.rejects(setApiTokenDevLog(id, 'everything'));
});

test('the notification is one clean line, and the relay accepts it', () => {
  const n = devLogNotification({
    level: 'error',
    scope: 'db',
    message: 'line one\nline two',
    instance: ORIGIN,
  });
  assert.equal(n.threadId, 'devlog');
  assert.match(n.subtitle, /Error · db/);
  assert.doesNotMatch(n.body, /\n/);
  assert.equal(validNotification({ ...n, data: { ...n.data, server: ORIGIN } }), true);
  assert.equal(
    validNotification({ ...n, data: { kind: 'devlog', server: ORIGIN, level: 'nope' } }),
    false,
    'only the two levels'
  );
});
