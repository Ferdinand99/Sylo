// Sending notifications through Postal Pigeon (src/lib/push.js): a device that gave a handle gets
// its notification through Pigeon while others on the same instance keep the older ways; what
// goes to Pigeon is a handle, a random reference and a collapse key, never the text; and the
// limits that keep this instance within Pigeon's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import express from 'express';
import { D_GUILD, startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, apiTokenPush, setApiTokenPush, setApiTokenDevLog } =
  await import('../src/db/apiTokens.js');
const { findPushEvent } = await import('../src/db/pushEvents.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { createPushRelayRouter } = await import('../src/web/routes/pushRelay.js');
const { peek } = await import('../src/lib/metrics.js');
const push = await import('../src/lib/push.js');

const {
  configurePush,
  resetPushState,
  notifyTicketActivity,
  notifyDevLogEvent,
  registerDevice,
  collapseKey,
} = push;
const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const ORIGIN = 'https://sylo.example.com';
const PIGEON = 'https://pigeon.example.test';
const OPERATOR = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let seq = 0;
const handle = () => `hrh_${(++seq).toString(16).padStart(40, 'h')}`;
const device = () => (++seq).toString(16).padStart(64, 'e');
let clock = Date.now();

/** A fake Pigeon client: records what it is asked and answers from `answer`. */
const asked = [];
let answer = () => ({ status: 'accepted' });
const fakePigeon = {
  send: async (h, message) => {
    asked.push({ handle: h, ...message });
    return answer(h, message);
  },
  ensureRegistered: async () => true,
  suspended: () => false,
};

// Members the bot has not cached cannot be found, so only the current test's people get anything.
const realFetch = guild.members.fetch;
guild.members.fetch = async (id) => {
  const member = guild.members.cache.get(id);
  if (!member) throw new Error('Unknown Member');
  return member;
};

function memberObject(id, perms) {
  return {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache: { hasAny: () => false, some: () => false } },
  };
}

/** Someone with Manage Server in D_GUILD, signed in to the app with the given push setup. */
async function staffDevice({ setup = { pigeonHandle: handle() }, proven = false, platformUserId } = {}) {
  const id = platformUserId ?? uid('3333333333');
  const { accountId } = await signInIdentity({
    platform: 'discord',
    platformUserId: id,
    username: 'u',
    avatar: null,
    guildIds: [D_GUILD],
  });
  const { id: tokenId } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: HOUR });
  if (setup) await setApiTokenPush(tokenId, { ...setup, environment: 'production', origin: ORIGIN });
  if (setup?.pigeonHandle && proven) {
    const { markApiTokenPigeonProven } = await import('../src/db/apiTokens.js');
    await markApiTokenPigeonProven(tokenId, setup.pigeonHandle, clock);
  }
  guild.members.cache.set(id, memberObject(id, ['ManageGuild']));
  return { id, tokenId, handle: setup?.pigeonHandle };
}

const notify = (ticketId, { isNew = true, content = 'my secret order number' } = {}) =>
  notifyTicketActivity({ guild, ticketId, member: 'ferdi', content, isNew });

test.beforeEach(async () => {
  for (const m of guild.members.cache.keys()) guild.members.cache.delete(m);
  asked.length = 0;
  answer = () => ({ status: 'accepted' });
  clock += 3 * HOUR; // far from the previous test's budgets
  resetPushState();
  configurePush({
    relayUrl: 'http://relay.invalid',
    pigeonUrl: PIGEON,
    pigeon: fakePigeon,
    apns: null,
    deliver: null,
    fetchImpl: null,
    now: () => clock,
  });
  await setBotMasterRoles(D_GUILD, []);
  await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [] } });
});
test.after(() => {
  guild.members.fetch = realFetch;
  resetPushState();
  configurePush({
    relayUrl: null,
    pigeonUrl: null,
    pigeon: undefined,
    apns: undefined,
    deliver: null,
    now: Date.now,
  });
});

test('a device with a handle is notified through Pigeon: a handle, a reference and a collapse key, no text', async () => {
  const a = await staffDevice({ proven: true });
  const result = await notify(7, { content: 'my secret order number' });
  assert.equal(result.sent, 1);
  assert.equal(asked.length, 1);
  const call = asked[0];
  assert.deepEqual(Object.keys(call).sort(), ['collapse', 'handle', 'ref']);
  assert.equal(call.handle, a.handle);
  assert.match(call.ref, /^[A-Za-z0-9_-]{22}$/);
  assert.match(call.collapse, /^[A-Za-z0-9_-]{1,32}$/);
  const text = JSON.stringify(call);
  for (const secret of ['secret', 'ferdi', 'order', 'D-main', D_GUILD, ORIGIN]) {
    assert.ok(!text.includes(secret), `${secret} must not go to Pigeon`);
  }
});

test('the text waits behind the reference, for that device only, and has no server address', async () => {
  const a = await staffDevice({ proven: true });
  const b = await staffDevice({ proven: true });
  await notify(8);
  assert.equal(asked.length, 2);
  const refOf = (who) => asked.find((c) => c.handle === who.handle).ref;
  assert.notEqual(refOf(a), refOf(b), 'a reference per recipient');

  assert.deepEqual(await findPushEvent(refOf(a), a.tokenId, clock), {
    title: 'D-main',
    subtitle: 'New ticket',
    body: 'ferdi: my secret order number',
    threadId: `${D_GUILD}:8`,
    kind: 'ticket',
    data: { kind: 'ticket', guildId: D_GUILD, ticketId: 8 },
  });
  assert.equal(await findPushEvent(refOf(a), b.tokenId, clock), null, 'not b’s');
  assert.equal(await findPushEvent(refOf(b), a.tokenId, clock), null, 'not a’s');
  assert.equal(await findPushEvent(refOf(a), a.tokenId, clock + 2 * HOUR), null, 'expires after 2 hours');
});

test('the same ticket on one device collapses to the same key, another ticket or device does not', async () => {
  const one = await staffDevice({ proven: true });
  await notify(10);
  clock += MINUTE;
  await notify(10, { isNew: false });
  await notify(11);
  const [first, again, other] = asked.map((c) => c.collapse);
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(first, collapseKey(one.tokenId, `${D_GUILD}:10`));
  for (const key of [first, other, collapseKey(one.tokenId, 'devlog')]) {
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  }
  assert.notEqual(collapseKey(one.tokenId, 'devlog'), first);
});

test('the collapse key is keyed: it needs SESSION_SECRET to compute, and differs per device', async () => {
  const one = await staffDevice({ proven: true });
  const two = await staffDevice({ proven: true });
  await notify(12);
  const keyOf = (who) => asked.find((c) => c.handle === who.handle).collapse;
  assert.notEqual(keyOf(one), keyOf(two), 'two devices of one server never share a value');

  const thread = `${D_GUILD}:12`;
  // What anyone who knows the server and ticket (public ids) could work out without the secret.
  const unkeyed = [
    createHash('sha256').update(thread).digest('base64url').slice(0, 32),
    createHash('sha256').update(`${one.tokenId}:${thread}`).digest('base64url').slice(0, 32),
    createHash('sha256').update(`${one.tokenId}\0${thread}`).digest('base64url').slice(0, 32),
    createHmac('sha256', '').update(`${one.tokenId}\0${thread}`).digest('base64url').slice(0, 32),
    // The session secret itself as the key, without the derivation for this purpose.
    createHmac('sha256', process.env.SESSION_SECRET)
      .update(`${one.tokenId}\0${thread}`)
      .digest('base64url')
      .slice(0, 32),
  ];
  assert.ok(!unkeyed.includes(keyOf(one)), 'not an unkeyed hash of what is public');

  // With the secret and the derivation it is exactly this, and another secret gives another key.
  const derive = (secret) => Buffer.from(hkdfSync('sha256', secret, 'sylo', 'pigeon-collapse', 32));
  const expected = (secret) =>
    createHmac('sha256', derive(secret)).update(`${one.tokenId}\0${thread}`).digest('base64url').slice(0, 32);
  assert.equal(keyOf(one), expected(process.env.SESSION_SECRET));
  assert.notEqual(keyOf(one), expected('another-secret'));

  // Nothing readable about the thread is in what Pigeon gets.
  const wire = JSON.stringify(asked);
  for (const secret of [D_GUILD, ':12', 'devlog']) assert.ok(!wire.includes(secret), secret);
});

test('three recipients on one instance: direct, Pigeon and nothing for a handle without Pigeon', async () => {
  const calls = [];
  configurePush({
    apns: {
      send: async (msg) => {
        calls.push(msg);
        return { status: 'ok' };
      },
    },
  });
  const viaPigeon = await staffDevice({ proven: true });
  const direct = await staffDevice({ setup: { deviceToken: device() } });
  const result = await notify(20);
  assert.equal(result.sent, 2);
  assert.deepEqual(
    asked.map((c) => c.handle),
    [viaPigeon.handle]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deviceToken, (await apiTokenPush(direct.tokenId)).deviceToken);
  assert.equal(
    calls[0].payload.aps.alert.body,
    'ferdi: my secret order number',
    'older apps still get the text'
  );
});

test('three recipients on one instance: relay, Pigeon', async () => {
  const relayCalls = [];
  const relayApp = express();
  relayApp.use(express.json());
  relayApp.use(
    '/api/push-relay/v1',
    createPushRelayRouter({
      apns: {
        send: async (msg) => {
          relayCalls.push(msg);
          return { status: 'ok' };
        },
      },
    })
  );
  const server = await new Promise((resolve) => {
    const s = relayApp.listen(0, () => resolve(s));
  });
  try {
    const relayUrl = `http://127.0.0.1:${server.address().port}`;
    configurePush({ relayUrl, fetchImpl: null });
    const deviceToken = device();
    const res = await fetch(`${relayUrl}/api/push-relay/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken, environment: 'production', instance: ORIGIN }),
    });
    const { relayToken } = await res.json();
    const viaPigeon = await staffDevice({ proven: true });
    await staffDevice({ setup: { relayToken } });
    const result = await notify(21);
    assert.equal(result.sent, 2);
    assert.deepEqual(
      asked.map((c) => c.handle),
      [viaPigeon.handle]
    );
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0].deviceToken, deviceToken);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('without Pigeon on this instance a handle is skipped, and the older ways go on', async () => {
  configurePush({ pigeonUrl: null });
  await staffDevice({ proven: true });
  const result = await notify(22);
  assert.equal(result.sent, 0);
  assert.equal(asked.length, 0);
});

test('the registered handle is what is used, with Pigeon alone on the instance', async () => {
  configurePush({ relayUrl: null });
  assert.equal(push.pushMode(), null);
  assert.equal(push.canPush(), true, 'Pigeon alone is enough to push');
  const a = await staffDevice();
  await registerDevice(a.tokenId, {
    pigeonHandle: 'hrh_registered_by_the_app_1234',
    environment: 'production',
    origin: ORIGIN,
  });
  assert.equal((await notify(23)).sent, 1);
  assert.equal(asked[0].handle, 'hrh_registered_by_the_app_1234');
  configurePush({ pigeonUrl: null });
  assert.equal(push.canPush(), false);
  await assert.rejects(
    () =>
      registerDevice(a.tokenId, {
        pigeonHandle: 'hrh_registered_by_the_app_1234',
        environment: 'production',
        origin: ORIGIN,
      }),
    { code: 'push_unavailable' }
  );
});

test('gone: the handle is forgotten and the content removed; the next notification sends nothing', async () => {
  const a = await staffDevice({ proven: true });
  answer = () => ({ status: 'gone' });
  const result = await notify(30);
  assert.equal(result.sent, 0);
  const push1 = await apiTokenPush(a.tokenId);
  assert.equal(push1.enabled, false);
  assert.equal(push1.pigeonHandle, null);
  assert.equal(await findPushEvent(asked[0].ref, a.tokenId, clock), null, 'nobody will ask for it');

  await notify(31);
  assert.equal(asked.length, 1, 'no handle, no request');
});

test('gone does not undo a handle the app registered since', async () => {
  const a = await staffDevice({ proven: true });
  const fresh = 'hrh_a_newer_handle_from_the_app_1';
  answer = async () => {
    await setApiTokenPush(a.tokenId, { pigeonHandle: fresh, environment: 'production', origin: ORIGIN });
    return { status: 'gone' };
  };
  await notify(32);
  assert.equal((await apiTokenPush(a.tokenId)).pigeonHandle, fresh);
});

test('limited is not sent again, and neither is anything else that fails: no retry, no content left', async () => {
  const a = await staffDevice({ proven: true });
  for (const status of ['limited', 'unavailable', 'unsupported_kind']) {
    asked.length = 0;
    answer = () => ({ status, reason: 'x' });
    clock += HOUR; // a fresh budget each time
    resetPushState();
    const result = await notify(40);
    assert.equal(result.sent, 0, status);
    assert.equal(asked.length, 1, `${status}: asked once`);
    assert.equal(await findPushEvent(asked[0].ref, a.tokenId, clock), null, `${status}: content removed`);
    assert.equal((await apiTokenPush(a.tokenId)).pigeonHandle, a.handle, `${status}: the handle stays`);
  }
});

test('the first acceptance proves the handle', async () => {
  const a = await staffDevice();
  assert.equal((await apiTokenPush(a.tokenId)).pigeonProvenAt, null);
  assert.equal((await notify(50)).sent, 1);
  assert.equal((await apiTokenPush(a.tokenId)).pigeonProvenAt, clock);
  // A refusal does not.
  clock += 2 * MINUTE; // past the pause between sends to unconfirmed handles
  const b = await staffDevice();
  answer = () => ({ status: 'unavailable' });
  await notify(51);
  assert.equal((await apiTokenPush(b.tokenId)).pigeonProvenAt, null);
});

test('unconfirmed handles: one send a minute across all of them, so junk cannot use up Pigeon’s unknown-handle budget', async () => {
  const devices = [await staffDevice(), await staffDevice(), await staffDevice()];
  const before = peek('sylo_push_pigeon_total', { result: 'throttled' });
  const result = await notify(60);
  assert.equal(result.sent, 1, 'only one of three unproven handles');
  assert.equal(asked.length, 1);
  assert.equal(peek('sylo_push_pigeon_total', { result: 'throttled' }) - before, 2);

  clock += MINUTE + 1;
  await notify(61);
  const handles = asked.map((c) => c.handle);
  // The one that was accepted is no longer throttled; of the other two, one goes this minute.
  assert.equal(asked.length, 3);
  assert.equal(new Set(handles).size, 2);
  assert.ok(devices.some((d) => handles.includes(d.handle)));
});

test('an unconfirmed handle that never works gets 3 sends an hour, then none until the hour is over', async () => {
  const a = await staffDevice();
  answer = () => ({ status: 'unavailable' }); // never accepted: stays unproven
  let sent = 0;
  for (let i = 0; i < 6; i += 1) {
    clock += MINUTE + 1;
    asked.length = 0;
    await notify(70 + i);
    sent += asked.length;
  }
  assert.equal(sent, 3);
  clock += HOUR;
  asked.length = 0;
  await notify(80);
  assert.equal(asked.length, 1, 'the hour is over');
  assert.equal((await apiTokenPush(a.tokenId)).pigeonProvenAt, null);
});

test('a confirmed handle gets 6 an hour, 3 at once, as Pigeon allows', async () => {
  await staffDevice({ proven: true });
  const limited = () => peek('sylo_push_pigeon_total', { result: 'limited' });
  const before = limited();
  const sent = [];
  for (let ticket = 100; ticket < 104; ticket += 1) sent.push((await notify(ticket)).sent);
  assert.deepEqual(sent, [1, 1, 1, 0], 'a burst of 3, then the fourth is dropped here, not at Pigeon');
  assert.equal(asked.length, 3);
  assert.equal(limited() - before, 1, 'counted');

  clock += 10 * MINUTE + 1000; // one more is allowed every 10 minutes
  assert.equal((await notify(104)).sent, 1);
  assert.equal((await notify(105)).sent, 0);
  clock += HOUR;
  assert.deepEqual([(await notify(106)).sent, (await notify(107)).sent, (await notify(108)).sent], [1, 1, 1]);
  assert.equal((await notify(109)).sent, 0);
});

test('replies in one ticket are still one notification per device per 30 seconds', async () => {
  await staffDevice({ proven: true });
  assert.equal((await notify(120, { isNew: false })).sent, 1);
  clock += 10_000;
  assert.equal((await notify(120, { isNew: false })).sent, 0);
  assert.equal(asked.length, 1);
  clock += 25_000;
  assert.equal((await notify(120, { isNew: false })).sent, 1);
  assert.equal(asked[0].collapse, asked[1].collapse, 'and the phone shows one notification for the ticket');
});

test('the dev log goes to operators only, through Pigeon, with no server address in the content', async () => {
  const operator = await staffDevice({ proven: true, platformUserId: OPERATOR });
  const other = await staffDevice({ proven: true });
  await setApiTokenDevLog(operator.tokenId, 'warnings');
  await setApiTokenDevLog(other.tokenId, 'warnings');
  const result = await notifyDevLogEvent({
    level: 'error',
    scope: 'db',
    message: 'connection lost to the database',
  });
  assert.deepEqual(result.recipients, [operator.tokenId]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].handle, operator.handle);
  assert.equal(asked[0].collapse, collapseKey(operator.tokenId, 'devlog'));
  assert.match(asked[0].collapse, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(asked[0]).includes('devlog'), 'not even that it is the dev log');
  assert.ok(!JSON.stringify(asked[0]).includes('connection lost'));
  const content = await findPushEvent(asked[0].ref, operator.tokenId, clock);
  assert.equal(content.kind, 'devlog');
  assert.deepEqual(content.data, { kind: 'devlog', level: 'error' });
  assert.equal(content.threadId, 'devlog');
  assert.match(content.body, /connection lost to the database/);
  assert.ok(!JSON.stringify(content).includes(ORIGIN));
});

test('a custom deliver hook still replaces the whole sending', async () => {
  await staffDevice({ proven: true });
  const seen = [];
  configurePush({
    deliver: async (recipient, notification) => {
      seen.push({ recipient, notification });
      return 'ok';
    },
  });
  assert.equal((await notify(130)).sent, 1);
  assert.equal(asked.length, 0);
  assert.equal(seen[0].notification.data.server, ORIGIN, 'the hook gets what it always got');
});

test('with the real Pigeon client, what goes over the wire is the handle, a reference and a collapse key', async () => {
  const requests = [];
  configurePush({
    pigeon: undefined,
    fetchImpl: async (target, init) => {
      const path = new URL(target).pathname;
      requests.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
      if (path === '/v1/challenge') {
        return Response.json({ challenge: 'k'.repeat(32), difficulty: 1, expires_at: 'x' });
      }
      if (path === '/v1/instances')
        return Response.json({ instance_credential: `hrk_${'z'.repeat(40)}` }, { status: 201 });
      return Response.json({ results: [{ status: 'accepted' }] });
    },
  });
  const a = await staffDevice({ proven: true });
  const result = await notify(140, { content: 'a private message' });
  assert.equal(result.sent, 1);
  const wire = requests.find((r) => r.path === '/v1/push');
  assert.deepEqual(Object.keys(wire.body).sort(), ['collapse', 'event_id', 'handles', 'kind', 'ref', 'ttl']);
  assert.deepEqual(wire.body.handles, [a.handle]);
  assert.equal(wire.body.kind, 'alert');
  assert.ok(!wire.init.body.includes('private'));
  assert.ok(!wire.init.body.includes('ferdi'));
  assert.equal(await (await import('../src/db/appSettings.js')).getAppSetting('pigeon_url'), PIGEON);
  assert.ok(await findPushEvent(wire.body.ref, a.tokenId, clock), 'the reference leads to the text');
});
