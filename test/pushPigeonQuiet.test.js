// The dev-log notifications are themselves a dev-log sink (src/index.js), so sending them must
// never log a warning or an error: that would become a new dev-log entry, and so another
// notification, for as long as Pigeon is down. This runs the real Pigeon client through every way
// it can fail while an operator's dev-log notification is sent, and counts the dev-log events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, setApiTokenPush, apiTokenPush } = await import('../src/db/apiTokens.js');
const { markApiTokenPigeonProven } = await import('../src/db/apiTokens.js');
const { setAppSetting } = await import('../src/db/appSettings.js');
const { addDevLogSink, _clearDevLogSinks } = await import('../src/lib/devLog.js');
const { configurePush, resetPushState, notifyDevLogEvent, warmUpPigeon } = await import('../src/lib/push.js');

const PIGEON = 'https://pigeon.example.test';
const OPERATOR = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js
const HOUR = 60 * 60_000;
let clock = Date.now();
let mode = 'down';
const events = [];
let eventNo = 0;

const json = (status, body) => Response.json(body, { status });
async function fakeFetch(target) {
  const path = new URL(target).pathname;
  if (mode === 'down') return json(503, { error: 'overloaded' });
  if (path === '/v1/challenge') return json(200, { challenge: 'k'.repeat(32), difficulty: 1 });
  if (path === '/v1/instances') return json(201, { instance_credential: `hrk_${'z'.repeat(40)}` });
  if (mode === 'suspended') return json(403, { error: 'suspended' });
  return json(200, { results: [{ status: 'unavailable' }] });
}

let tokenId;
test.before(async () => {
  const { accountId } = await signInIdentity({
    platform: 'discord',
    platformUserId: OPERATOR,
    username: 'u',
    avatar: null,
    guildIds: [],
  });
  ({ id: tokenId } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: HOUR }));
  const handle = `hrh_${'q'.repeat(40)}`;
  await setApiTokenPush(tokenId, {
    pigeonHandle: handle,
    environment: 'production',
    origin: 'https://s.example',
  });
  await markApiTokenPigeonProven(tokenId, handle);
  resetPushState();
  configurePush({
    relayUrl: null,
    apns: null,
    deliver: null,
    pigeonUrl: PIGEON,
    pigeon: undefined,
    fetchImpl: fakeFetch,
    now: () => clock,
  });
  _clearDevLogSinks();
  addDevLogSink((event) => events.push(event));
});
test.after(() => {
  _clearDevLogSinks();
  resetPushState();
  configurePush({ pigeonUrl: null, pigeon: undefined, fetchImpl: null, now: Date.now });
});

/** One dev-log notification to the operator, with a clock past every pause and budget. */
async function sendDevLog() {
  clock += 2 * HOUR;
  resetPushState();
  const result = await notifyDevLogEvent({
    level: 'error',
    scope: 'quiet-test',
    message: `something broke ${++eventNo}`,
  });
  await new Promise((resolve) => setTimeout(resolve, 20)); // sinks run on a promise
  return result;
}

test('a Pigeon that is down, refuses, is suspended or a credential that cannot be opened never makes a dev-log event', async () => {
  assert.ok((await apiTokenPush(tokenId)).pigeonHandle);

  mode = 'down'; // registration fails
  assert.equal((await sendDevLog()).sent, 0);

  mode = 'unavailable'; // registers, then Pigeon says unavailable
  assert.equal((await sendDevLog()).sent, 0);

  await setAppSetting('pigeon_credential', 'v1.garbage.garbage.garbage'); // cannot be opened
  assert.equal((await sendDevLog()).sent, 0);

  mode = 'suspended'; // the relay refuses this server
  assert.equal((await sendDevLog()).sent, 0);

  assert.deepEqual(
    events.map((e) => `${e.level} ${e.scope} ${e.message}`),
    [],
    'nothing on the sink path reached the dev log'
  );
});

test('start-up registration, which is not on the sink path, still says when it fails', async () => {
  mode = 'down';
  clock += 2 * HOUR;
  await setAppSetting('pigeon_credential', 'v1.garbage.garbage.garbage');
  await warmUpPigeon();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    events.some((e) => e.level === 'warn' && e.scope === 'pigeon'),
    'a warning, so a broken set-up is noticed'
  );
});
