import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  denyLockPerms,
  restoreLockPerms,
  lockChannel,
  unlockChannel,
  LOCK_PERMS,
} from '../src/bot/lib/channelLock.js';
import {
  recordChannelLock,
  getChannelLock,
  isChannelLocked,
  clearChannelLock,
  guildChannelLocks,
  lockdownChannelLocks,
  clearGuildChannelLocks,
} from '../src/db/channelLocks.js';

const G = '900000000000000010';
const C1 = '700000000000000001';
const C2 = '700000000000000002';

const EVERYONE = 'everyone-id';

/** Minimal stand-in for a guild text channel. */
function fakeChannel(channelId, existing) {
  const cache = new Map();
  if (existing) cache.set(EVERYONE, existing);
  const edits = [];
  const deletes = [];
  return {
    id: channelId,
    guild: { id: G, roles: { everyone: { id: EVERYONE } }, members: { me: {} } },
    permissionOverwrites: {
      cache,
      edit: async (role, opts, meta) => edits.push({ role, opts, meta }),
      delete: async (role, reason) => deletes.push({ role, reason }),
    },
    _edits: edits,
    _deletes: deletes,
  };
}

const overwrite = (allow, deny) => ({ allow: { bitfield: allow }, deny: { bitfield: deny } });

test('denyLockPerms denies every lock permission', () => {
  const map = denyLockPerms();
  assert.deepEqual(Object.keys(map).sort(), [...LOCK_PERMS].sort());
  assert.ok(Object.values(map).every((v) => v === false));
});

test('restoreLockPerms maps saved bitfields back to true / false / null', () => {
  const allow = PermissionFlagsBits.SendMessages;
  const deny = PermissionFlagsBits.AddReactions;
  const map = restoreLockPerms(allow, deny);

  assert.equal(map.SendMessages, true); // was explicitly allowed
  assert.equal(map.AddReactions, false); // was explicitly denied
  assert.equal(map.CreatePublicThreads, null); // was inherited
  // Accepts decimal strings (how the row is stored) too.
  assert.deepEqual(restoreLockPerms(String(allow), String(deny)), map);
});

test('channel_locks DB round-trips and scopes by guild', async () => {
  await clearGuildChannelLocks(G);
  await recordChannelLock({
    guildId: G,
    channelId: C1,
    prevAllow: PermissionFlagsBits.SendMessages,
    prevDeny: 0n,
    hadOverwrite: true,
    lockedBy: 'mod#1',
    lockdown: false,
  });

  assert.equal(await isChannelLocked(G, C1), true);
  const row = await getChannelLock(G, C1);
  assert.equal(row.prev_allow, String(PermissionFlagsBits.SendMessages));
  assert.equal(row.prev_deny, '0');
  assert.equal(row.had_overwrite, 1);
  assert.equal(row.lockdown, 0);

  assert.equal(await clearChannelLock(G, C1), 1);
  assert.equal(await isChannelLocked(G, C1), false);
});

test('lockdownChannelLocks returns only rows flagged lockdown', async () => {
  await clearGuildChannelLocks(G);
  await recordChannelLock({ guildId: G, channelId: C1, lockedBy: 'm', lockdown: true });
  await recordChannelLock({ guildId: G, channelId: C2, lockedBy: 'm', lockdown: false });

  assert.deepEqual(
    (await lockdownChannelLocks(G)).map((r) => r.channel_id),
    [C1]
  );
  assert.equal((await guildChannelLocks(G)).length, 2);
});

test('lockChannel records the prior overwrite once, then denies the lock perms', async () => {
  await clearGuildChannelLocks(G);
  const ch = fakeChannel(C1, overwrite(PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions));

  await lockChannel(ch, { moderatorTag: 'mod#1' });
  const saved = await getChannelLock(G, C1);
  assert.equal(saved.had_overwrite, 1);
  assert.equal(saved.prev_allow, String(PermissionFlagsBits.SendMessages));
  assert.equal(saved.prev_deny, String(PermissionFlagsBits.AddReactions));
  assert.deepEqual(ch._edits.at(-1).opts, denyLockPerms());

  // A second lock must not clobber the saved baseline with the locked values.
  await lockChannel(ch, { moderatorTag: 'mod#2' });
  assert.deepEqual(await getChannelLock(G, C1), saved);
});

test('unlockChannel restores the saved overwrite and clears the row', async () => {
  await clearGuildChannelLocks(G);
  const ch = fakeChannel(C1, overwrite(PermissionFlagsBits.SendMessages, 0n));
  await lockChannel(ch, { moderatorTag: 'mod#1' });

  await unlockChannel(ch, { moderatorTag: 'mod#1' });
  assert.equal(await getChannelLock(G, C1), null);
  assert.equal(ch._edits.at(-1).opts.SendMessages, true); // restored to allow
  assert.equal(ch._edits.at(-1).opts.CreatePublicThreads, null);
});

test('unlockChannel deletes the overwrite when there was none before the lock', async () => {
  await clearGuildChannelLocks(G);
  const ch = fakeChannel(C1, null); // no @everyone overwrite existed
  await lockChannel(ch, { moderatorTag: 'mod#1' });
  assert.equal((await getChannelLock(G, C1)).had_overwrite, 0);

  await unlockChannel(ch, { moderatorTag: 'mod#1' });
  assert.equal(ch._deletes.length, 1);
  assert.equal(await getChannelLock(G, C1), null);
});

test('on a platform without threads, the lock leaves the thread permissions out', async () => {
  const { runtime } = await import('../src/runtime.js');
  const { lockPermsFor } = await import('../src/bot/lib/channelLock.js');
  assert.deepEqual(lockPermsFor('fluxer'), ['SendMessages', 'AddReactions']);
  assert.deepEqual(lockPermsFor('discord'), LOCK_PERMS);
  assert.deepEqual(Object.keys(denyLockPerms('fluxer')), ['SendMessages', 'AddReactions']);
  assert.deepEqual(Object.keys(restoreLockPerms(0n, 0n, 'fluxer')), ['SendMessages', 'AddReactions']);

  await clearGuildChannelLocks(G);
  const fluxer = {};
  runtime.clients.fluxer = fluxer;
  try {
    const ch = fakeChannel(C2, undefined);
    ch.guild.client = fluxer;
    await lockChannel(ch, { moderatorTag: 'mod#1' });
    assert.deepEqual(Object.keys(ch._edits.at(-1).opts), ['SendMessages', 'AddReactions']);
    await unlockChannel(ch, { moderatorTag: 'mod#1' });
  } finally {
    runtime.clients.fluxer = null;
  }
});
