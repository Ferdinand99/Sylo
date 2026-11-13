// The verify message is checked on every member join and on every settings save. It may only be posted
// again when the platform says the old one is gone: a missing permission, a timeout or a 5xx must not
// post a new one per join. A new channel gets a fresh message there and the old one is deleted.
import './helpers/tmpDb.js';
import './helpers/trustLoopbackProxy.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule, getGuildModule } from '../src/db/modules.js';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { runtime } from '../src/runtime.js';
import { setModuleConfigGuard } from '../src/db/modules.js';
import { dueVerificationKicks } from '../src/db/verificationKicks.js';
import { getComponentAction, saveComponentActions } from '../src/db/componentReactions.js';
import { ensureVerifyMessage, normaliseVerificationConfig, _internals } from '../src/modules/verification.js';
import {
  dropFakeClient,
  fakeChannel,
  fakeIntroGuild,
  GID,
  missingAccess,
  serverError,
  unknownMessage,
} from './helpers/fakeIntro.js';
import { ensureHoneypotMessages } from '../src/modules/honeypot.js';

const A = '101000000000000601';
const B = '102000000000000602';
const ROLE_ID = '100000000000000801';

test.after(() => dropFakeClient());

/** The intro fake with two verify channels that keep their messages and can be made to fail. */
function setup() {
  const env = fakeIntroGuild();
  const { guild } = env;
  const chans = {};
  for (const [name, id] of [
    ['a', A],
    ['b', B],
  ]) {
    const ch = fakeChannel(id, name);
    const fetch = ch.messages.fetch;
    ch.messages.fetch = async (messageId) => {
      if (ch.failFetch) throw ch.failFetch;
      const found = ch.store.get(messageId);
      if (!found) throw unknownMessage();
      return fetch(messageId);
    };
    const send = ch.send;
    ch.send = async (payload) => {
      if (ch.failSend) throw ch.failSend;
      return send(payload);
    };
    guild.channels.cache.set(id, ch);
    chans[name] = ch;
  }
  return { guild, ...chans };
}

const base = (extra = {}) =>
  normaliseVerificationConfig({ mode: 'button', verifiedRoleId: ROLE_ID, channelId: A, ...extra });
const save = (config) => setGuildModule(GID, 'verification', { enabled: true, config });
const stored = async () => (await getGuildModule(GID, 'verification')).config;
// A join does not wait for the check of the verify message, so wait for it here.
const join = async (guild, n, key = GID) => {
  await dispatch('guildMemberAdd', key, { id: `70000000000000${String(10 + n)}`, guild, user: {} });
  await _internals.settled(guild);
};
const ids = (ch) => [...ch.store.keys()];

test('five joins in a row with a 403 or a 5xx on the lookup post nothing new', async () => {
  for (const fail of [missingAccess(), serverError()]) {
    const { guild, a } = setup();
    await save(base());
    await ensureVerifyMessage(guild);
    const first = (await stored()).messageId;
    assert.ok(first, 'the first message is posted');
    assert.deepEqual(ids(a), [first]);

    a.failFetch = fail;
    for (let n = 0; n < 5; n += 1) await join(guild, n);
    assert.equal(a.log.sent.length, 1, `no repost after: ${fail.message}`);
    assert.equal((await stored()).messageId, first);

    // The same burst at once.
    await Promise.all([0, 1, 2, 3, 4].map((n) => join(guild, n)));
    assert.equal(a.log.sent.length, 1);
  }
});

test('the permission check asks for Read Message History and stops, quietly, when it is missing', async () => {
  const { guild, a } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  assert.ok(a.asked.includes('ReadMessageHistory'), 'the check names Read Message History');

  const { guild: g2, a: a2 } = setup();
  _internals.warnedPermissions.clear();
  a2.permissionsFor = () => ({ has: (needed) => !needed.includes('ReadMessageHistory') });
  await save(base());
  const warned = mock.method(console, 'error', () => {});
  try {
    await ensureVerifyMessage(g2);
  } finally {
    warned.mock.restore();
  }
  assert.equal(a2.log.sent.length, 0, 'nothing is posted without the permission');
  assert.ok(
    warned.mock.calls.some((c) => /Read Message History|ReadMessageHistory/.test(String(c.arguments[0])))
  );
});

test('a verify message that is gone is posted again once, even for a burst of joins', async () => {
  const { guild, a } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  const first = (await stored()).messageId;
  a.store.clear();

  await Promise.all([0, 1, 2, 3, 4].map((n) => join(guild, n)));
  assert.equal(a.log.sent.length, 2, 'one new post for five joins');
  const now = (await stored()).messageId;
  assert.notEqual(now, first);
  assert.deepEqual(ids(a), [now]);
});

test('a new channel gets a fresh message and the old one is deleted after the new id is stored', async () => {
  const { guild, a, b } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  const old = (await stored()).messageId;
  assert.equal((await stored()).messageChannelId, A);

  await save({ ...(await stored()), channelId: B });
  await ensureVerifyMessage(guild);
  const now = await stored();
  assert.equal(now.channelId, B);
  assert.equal(now.messageChannelId, B);
  assert.notEqual(now.messageId, old);
  assert.deepEqual(ids(a), [], 'the old post is gone from the old channel');
  assert.deepEqual(ids(b), [now.messageId]);
});

test('a failing post in the new channel leaves the stored pair and the old message alone', async () => {
  const { guild, a, b } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  const before = await stored();
  b.failSend = missingAccess();
  await save({ ...before, channelId: B });
  await ensureVerifyMessage(guild);
  const now = await stored();
  assert.equal(now.messageId, before.messageId);
  assert.equal(now.messageChannelId, A);
  assert.deepEqual(ids(a), [before.messageId]);

  // A join while the channel is still broken posts nothing and deletes nothing.
  await join(guild, 1);
  assert.deepEqual(ids(a), [before.messageId]);
  assert.deepEqual(ids(b), []);
});

test('a failing delete of the old message is logged and does not undo the move', async () => {
  const { guild, a, b } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  a.failWith = missingAccess();
  await save({ ...(await stored()), channelId: B });
  const logged = mock.method(console, 'error', () => {});
  try {
    await ensureVerifyMessage(guild);
  } finally {
    logged.mock.restore();
  }
  const now = await stored();
  assert.equal(now.messageChannelId, B);
  assert.deepEqual(ids(b), [now.messageId]);
  assert.ok(logged.mock.calls.some((c) => /could not delete/i.test(String(c.arguments[0]))));
});

test('a config saved before the message channel was kept is read as "posted in the channel"', async () => {
  const { guild, a } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  const { messageId } = await stored();
  const legacy = { ...(await stored()) };
  delete legacy.messageChannelId;
  await save(legacy);
  await join(guild, 2);
  assert.equal(a.log.sent.length, 1, 'edited in place, not posted again');
  assert.equal((await stored()).messageId, messageId);
  assert.equal((await stored()).messageChannelId, A, 'and the channel is now kept');
});

// --- honeypot: the same rule for the trap messages -------------------------------------------------

test('honeypot: a trap message is posted again only when it is gone', async () => {
  const { guild, a } = setup();
  const row = (messageId) => ({
    channelId: A,
    messageId,
    bait: 'do not',
    action: 'kick',
    timeoutMinutes: 10,
  });
  const cfg = (messageId) => ({ exemptRoles: [], channels: [], messages: [row(messageId)] });
  await setGuildModule(GID, 'honeypot', { enabled: true, config: cfg('') });
  await ensureHoneypotMessages(guild, cfg(''));
  const first = (await getGuildModule(GID, 'honeypot')).config.messages[0].messageId;
  assert.ok(first);
  assert.equal(a.log.sent.length, 1);

  for (const fail of [missingAccess(), serverError()]) {
    a.failFetch = fail;
    const logged = mock.method(console, 'error', () => {});
    try {
      await ensureHoneypotMessages(guild, cfg(first));
    } finally {
      logged.mock.restore();
    }
    assert.equal(a.log.sent.length, 1, `no repost after: ${fail.message}`);
  }

  a.failFetch = null;
  a.store.clear();
  await ensureHoneypotMessages(guild, cfg(first));
  assert.equal(a.log.sent.length, 2, 'gone: posted again');
  assert.notEqual((await getGuildModule(GID, 'honeypot')).config.messages[0].messageId, first);
});

// --- a join never waits for the platform; checks coalesce; one warning ------------------------------

test('a lookup that never answers does not hold the join handlers, and times out', async () => {
  const { guild, a } = setup();
  await save(base({ kickAfterMinutes: 10 }));
  await ensureVerifyMessage(guild);
  const first = (await stored()).messageId;
  a.messages.fetch = () => new Promise(() => {}); // the platform never answers
  const old = _internals.timeoutMs;
  _internals.timeoutMs = 60;
  try {
    const member = { id: '700000000000000099', guild, user: {} };
    const done = await Promise.race([
      dispatch('guildMemberAdd', GID, member).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('blocked'), 1500)),
    ]);
    assert.equal(done, 'returned', 'the join handler does not wait for the check');
    const due = await dueVerificationKicks(Date.now() + 11 * 60_000);
    assert.ok(
      due.some((d) => d.user_id === member.id),
      'the kick is scheduled'
    );
    await _internals.settled(guild); // the check ends by its timeout
  } finally {
    _internals.timeoutMs = old;
  }
  assert.equal(a.log.sent.length, 1, 'a timed-out lookup posts nothing');
  assert.equal((await stored()).messageId, first);
});

test('checks that ask while one is waiting are answered by that one', async () => {
  const { guild, a } = setup();
  await save(base());
  await ensureVerifyMessage(guild);
  let lookups = 0;
  const fetch = a.messages.fetch;
  a.messages.fetch = async (id) => {
    lookups += 1;
    await new Promise((r) => setTimeout(r, 30));
    return fetch(id);
  };
  await Promise.all(Array.from({ length: 50 }, () => ensureVerifyMessage(guild)));
  assert.ok(lookups <= 2, `50 asks made ${lookups} lookups`);
  assert.equal(a.log.sent.length, 1);
});

test('a missing permission is warned about once per server, not on every join', async () => {
  const { guild, a } = setup();
  _internals.warnedPermissions.clear(); // once per process: start over for this test
  a.permissionsFor = () => ({ has: () => false });
  await save(base());
  const warned = mock.method(console, 'error', () => {});
  try {
    for (let n = 0; n < 5; n += 1) await join(guild, n);
  } finally {
    warned.mock.restore();
  }
  assert.equal(warned.mock.calls.filter((c) => /missing permissions/.test(String(c.arguments[0]))).length, 1);
  assert.equal(a.log.sent.length, 0);
});

test('a failed store removes the new post and a later check works (the queue is not stuck)', async () => {
  const { guild, a } = setup();
  await save(base());
  let failing = true;
  setModuleConfigGuard(() => {
    if (failing) throw new Error('the database is down');
  });
  try {
    await assert.rejects(ensureVerifyMessage(guild), /the database is down/);
    assert.deepEqual(ids(a), [], 'the new post is deleted again');
    failing = false;
    await ensureVerifyMessage(guild);
  } finally {
    setModuleConfigGuard(null);
  }
  const now = await stored();
  assert.ok(now.messageId);
  assert.deepEqual(ids(a), [now.messageId]);
  await _internals.settled(guild);
});

test('a check that throws does not block the next one for that server', async () => {
  const { guild, a } = setup();
  await save(base());
  setModuleConfigGuard(() => {
    throw new Error('first fails');
  });
  const first = ensureVerifyMessage(guild);
  const second = ensureVerifyMessage(guild); // waits behind the first
  const firstFailed = assert.rejects(first, /first fails/);
  await firstFailed;
  setModuleConfigGuard(null);
  await second;
  assert.equal(ids(a).length, 1);
});

// --- Fluxer: the key is "fluxer:<id>", deletes go through the compat shim -------------------------------

installFluxerCompat(sdk, { Collection });

const goneOnFluxer = () =>
  Object.assign(new Error('Could not fetch the message'), {
    cause: Object.assign(new Error('Unknown Message'), { statusCode: 404, code: 'UNKNOWN_MESSAGE' }),
  });

function fluxerSetup() {
  const env = fakeIntroGuild();
  const { guild } = env;
  const raw = '900000000000000555';
  guild.id = raw;
  const client = { guilds: { cache: new Map([[raw, guild]]) }, isReady: () => true, user: { id: 'bot' } };
  guild.client = client;
  runtime.clients.fluxer = client;
  const chans = {};
  for (const [name, id] of [
    ['a', A],
    ['b', B],
  ]) {
    const ch = fakeChannel(id, name);
    const fetch = async (messageId) => {
      if (ch.failFetch) throw ch.failFetch;
      const found = ch.store.get(messageId);
      if (!found) throw goneOnFluxer();
      return found;
    };
    ch.messages = Object.assign(Object.create(sdk.MessageManager.prototype), { fetch });
    guild.channels.cache.set(id, ch);
    chans[name] = ch;
  }
  return { guild, key: `fluxer:${raw}`, ...chans };
}

test('fluxer: a burst of joins reposts a gone message once, and never after a 403', async () => {
  const { guild, key, a } = fluxerSetup();
  try {
    await setGuildModule(key, 'verification', { enabled: true, config: base() });
    await ensureVerifyMessage(guild);
    const first = (await getGuildModule(key, 'verification')).config.messageId;
    assert.ok(first);

    a.failFetch = missingAccess();
    for (let n = 0; n < 5; n += 1) await join(guild, n, key);
    assert.equal(a.log.sent.length, 1, 'a 403 on the lookup posts nothing');

    a.failFetch = null;
    a.store.clear();
    await Promise.all([0, 1, 2, 3, 4].map((n) => join(guild, n, key)));
    assert.equal(a.log.sent.length, 2, 'gone: one new post for five joins');
  } finally {
    runtime.clients.fluxer = null;
  }
});

test('fluxer: a channel change deletes the old message through the shim and drops its stored action', async () => {
  const { guild, key, a, b } = fluxerSetup();
  try {
    await setGuildModule(key, 'verification', { enabled: true, config: base() });
    await ensureVerifyMessage(guild);
    const config = (await getGuildModule(key, 'verification')).config;
    const old = config.messageId;
    await saveComponentActions({
      guildId: key,
      channelId: A,
      messageId: old,
      actions: [{ kind: 'button', customId: 'verify:start', emoji: '✅' }],
    });
    await setGuildModule(key, 'verification', { config: { ...config, channelId: B } });
    await ensureVerifyMessage(guild);
    const now = (await getGuildModule(key, 'verification')).config;
    assert.equal(now.messageChannelId, B);
    assert.deepEqual([...a.store.keys()], [], 'the old message is deleted');
    assert.deepEqual([...b.store.keys()], [now.messageId]);
    assert.equal(await getComponentAction(old, '✅'), null);
  } finally {
    runtime.clients.fluxer = null;
  }
});
