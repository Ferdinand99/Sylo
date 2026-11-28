// What keeps a mirror from doing more than its owners agreed to (src/mirror/engine.js): only the servers' owners,
// deletions that lock instead of delete, a brake on bursts of deletes, the role hierarchy, privacy that never gets
// more open than on Discord, module settings that pass the dashboard's grant checks, and no second copy of anything.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { createEngine } from '../src/mirror/engine.js';
import { BIT, SYLO_ROLE, engineFor } from './helpers/mirrorFakes.js';
import { drain, scenario } from './helpers/mirrorScenario.js';

const OWNERS = { enforceOwnership: () => true };
const view = 1n << 10n;
const send = 1n << 11n;
const react = 1n << 6n;
const connect = 1n << 20n;
const mapped = async (s, kind, id) => (await db.getMapping(s.pair.id, kind, id)).targetId;

test('the owners who agreed must still own both servers: a transfer pauses the mirror until the new owner confirms', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: OWNERS });
  await s.engine.startCopy(s.pair.id);
  await s.engine.runPair(s.pair.id, { maxJobs: 3 });
  s.fluxer.guild.ownerId = 'new-fluxer-owner';
  s.fluxer.calls.length = 0;
  await s.engine.runPair(s.pair.id);
  let pair = await db.getPair(s.pair.id);
  assert.deepEqual([pair.status, pair.pauseKind], ['paused', 'ownership']);
  assert.match(pair.lastError, /changed hands/);
  assert.equal(s.fluxer.calls.length, 0, 'nothing is done for a mirror whose server changed hands');
  assert.equal((await s.engine.previewPair(pair)).blockers[0].code, 'ownership');

  // The Discord owner cannot confirm for the Fluxer server.
  pair = await s.engine.resume(s.pair.id, { side: 'source' });
  assert.equal(pair.status, 'paused');
  assert.match(pair.lastError, /Waiting for the owner of the Fluxer server/);
  // The new Fluxer owner confirms; the mirror goes on and records them as the person who agreed.
  pair = await s.engine.resume(s.pair.id, { side: 'target' });
  assert.equal(pair.status, 'copying');
  assert.equal(pair.targetConsentUser, 'new-fluxer-owner');
  assert.equal((await drain(s)).status, 'live');
});

test('when both servers change hands, both new owners have to confirm', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: OWNERS });
  await s.engine.startCopy(s.pair.id);
  s.discord.ownerId = 'new-discord-owner';
  s.fluxer.guild.ownerId = 'new-fluxer-owner';
  await s.engine.runPair(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).pauseKind, 'ownership');
  assert.equal((await s.engine.resume(s.pair.id, { side: 'target' })).status, 'paused');
  assert.equal((await s.engine.resume(s.pair.id, { side: 'source' })).status, 'copying');
});

test('a copy cannot start when the people who agreed no longer own the servers', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: OWNERS });
  s.discord.ownerId = 'someone-else'; // an Administrator, not the owner, is not enough
  await assert.rejects(s.engine.startCopy(s.pair.id), /changed hands/);
  assert.equal(s.fluxer.calls.length, 0);
  s.discord.ownerId = 'discord-owner';
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');
});

test('a pair with no recorded owners is not run when owners are enforced', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: OWNERS });
  await db.updatePair(s.pair.id, { sourceConsentUser: '' });
  await assert.rejects(s.engine.startCopy(s.pair.id), /changed hands/);
});

test('a delete on Discord locks the Fluxer copy by default; only "mirror deletions" deletes', async () => {
  const s = await scenario();
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const chat = await mapped(s, 'channel', s.k.chat);
  const mod = await mapped(s, 'role', s.k.mod);
  s.discord.channels.cache.delete(s.k.chat);
  s.discord.roles.cache.delete(s.k.mod);
  s.discord.emojis.cache.delete(s.k.emoji1);
  const note = (kind, id) => s.engine.noteSourceChange(s.k.src, { kind, op: 'delete', id });
  await note('channel', s.k.chat);
  await note('role', s.k.mod);
  await note('emoji', s.k.emoji1);
  s.fluxer.calls.length = 0;
  await s.engine.runPair(s.pair.id);
  for (const op of ['deleteChannel', 'deleteRole', 'deleteEmoji'])
    assert.equal(s.fluxer.ops(op).length, 0, op);
  const lock = s.fluxer.ops('editChannel').find((c) => c.id === chat);
  assert.deepEqual(lock.spec.permissionOverwrites, [
    { id: s.fluxer.guild.id, type: 0, allow: '0', deny: String(view | send | react | connect) },
  ]);
  assert.equal(s.fluxer.ops('editRole').find((c) => c.id === mod).spec.permissions, '0');
  assert.ok(s.fluxer.guild.channels.has(chat), 'the channel is still on Fluxer, with its messages');
  assert.ok((await db.getMapping(s.pair.id, 'channel', s.k.chat)).removedAt > 0);
  const progress = await s.engine.progress(await db.getPair(s.pair.id));
  assert.deepEqual(progress.removed.map((r) => [r.kind, r.label]).sort(), [
    ['channel', 'chat'],
    ['emoji', 'party'],
    ['role', 'Mod'],
  ]);

  // With the option on, the next delete is real, and only of what Sylo made.
  await db.updatePair(s.pair.id, { options: { ...s.pair.options, mirrorDeletes: true } });
  const rules = await mapped(s, 'channel', s.k.rules);
  s.discord.channels.cache.delete(s.k.rules);
  await note('channel', s.k.rules);
  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer.ops('deleteChannel').map((c) => c.id),
    [rules]
  );
});

test('the lock is not applied to something Sylo did not create', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  await db.putMapping({
    pairId: s.pair.id,
    kind: 'channel',
    sourceId: '770000000000000001',
    targetId: 'foreign',
    owned: false,
  });
  s.fluxer.calls.length = 0;
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'delete', id: '770000000000000001' });
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.calls.length, 0);
  assert.equal(await db.getMapping(s.pair.id, 'channel', '770000000000000001'), null);
});

test('a burst of deletes pauses the mirror, and only the owner confirming applies them', async () => {
  const s = await scenario({ options: { mirrorDeletes: true } });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  s.fluxer.calls.length = 0;
  const targets = [];
  const note = async (kind, id) => s.engine.noteSourceChange(s.k.src, { kind, op: 'delete', id });
  for (const id of [s.k.chat, s.k.rules, s.k.voice, s.k.cat, s.k.cat2]) {
    targets.push(await mapped(s, 'channel', id));
    s.discord.channels.cache.delete(id);
    await note('channel', id);
  }
  assert.equal((await db.getPair(s.pair.id)).status, 'live', 'five deletes are still fine');
  s.discord.emojis.cache.delete(s.k.emoji1);
  await note('emoji', s.k.emoji1);
  const pair = await db.getPair(s.pair.id);
  assert.deepEqual([pair.status, pair.pauseKind, pair.pausedBy], ['paused', 'deletes', 'system']);
  assert.match(pair.lastError, /6 things were deleted/);
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('deleteChannel').length, 0, 'nothing is deleted while the mirror waits');
  assert.equal(await db.openSyncCount(s.pair.id), 6, 'the deletes wait in the queue');

  // Real deletion is on, so the owner of the Discord server cannot confirm it: only the Fluxer owner can, and only after
  // being shown what will be deleted.
  await assert.rejects(
    s.engine.resume(s.pair.id, { side: 'source', confirm: true }),
    (e) => e.code === 'fluxer-owner-only'
  );
  await assert.rejects(s.engine.resume(s.pair.id, { side: 'target' }), (e) => {
    assert.equal(e.code, 'confirm-needed');
    assert.equal(e.deleteCount, 6);
    assert.ok(e.deletes.every((d) => d.action === 'delete'));
    assert.ok(e.deletes.some((d) => d.kind === 'channel' && d.name === 'chat'));
    return true;
  });
  assert.equal((await db.getPair(s.pair.id)).status, 'paused');
  const resumed = await s.engine.resume(s.pair.id, { side: 'target', confirm: true });
  assert.equal(resumed.status, 'live');
  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer
      .ops('deleteChannel')
      .map((c) => c.id)
      .sort(),
    targets.sort()
  );
  assert.equal(s.fluxer.ops('deleteEmoji').length, 1);
});

const BOSS = { id: '810000000000000005', name: 'Admins', position: 5 };
const roleBits = (s, id) => BigInt(s.fluxer.guild.roles.get(id)._permissions);
const ADMIN = 1n << 3n;
const MANAGE_ROLES = 1n << 28n;

test('a fresh Fluxer server (only Sylo at position 1) is fine: Sylo outranks what it makes, by id', async () => {
  const s = await scenario({ withExpressions: false });
  const preview = await s.engine.previewPair(s.pair);
  assert.equal(preview.ok, true, 'position 1 is not a problem: it is the top role');
  assert.equal(preview.blockers.length, 0);
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');
  const sylo = s.fluxer.guild.roles.get(SYLO_ROLE);
  for (const sourceId of [s.k.member, s.k.mod]) {
    const role = s.fluxer.guild.roles.get(await mapped(s, 'role', sourceId));
    assert.ok(sylo.position > role.position, 'Sylo stays above every role it made');
  }
});

test("the copy is refused, with advice, while a role ranks above or level with Sylo's", async () => {
  const above = await scenario({ withExpressions: false, fluxerOpts: { extraRoles: [BOSS] } });
  const preview = await above.engine.previewPair(above.pair);
  assert.equal(preview.ok, false);
  assert.equal(preview.blockers[0].code, 'role-hierarchy');
  assert.match(preview.blockers[0].message, /Admins/);
  assert.match(preview.blockers[0].message, /Server Settings, then Roles/);
  assert.match(preview.blockers[0].message, /Sylo cannot move its own role/);
  await assert.rejects(above.engine.startCopy(above.pair.id), /Admins/);
  assert.equal(above.fluxer.calls.length, 0);

  // Level with Sylo (same position) but older: it ranks above, so it blocks; a newer one does not.
  const older = await scenario({
    withExpressions: false,
    fluxerOpts: { extraRoles: [{ id: '800000000000000001', name: 'Older', position: 1 }] },
  });
  assert.equal((await older.engine.previewPair(older.pair)).blockers[0].code, 'role-hierarchy');
  const newer = await scenario({
    withExpressions: false,
    fluxerOpts: { extraRoles: [{ id: '820000000000000001', name: 'Newer', position: 1 }] },
  });
  assert.equal((await newer.engine.previewPair(newer.pair)).ok, true);

  // Sylo's own role unknown: also refused, with the advice to check it.
  const unknown = await scenario({ withExpressions: false });
  unknown.fluxer.target.rolesAboveSylo = () => null;
  assert.match((await unknown.engine.previewPair(unknown.pair)).blockers[0].message, /could not be read/);

  // Roles the mirror made itself do not count, and with roles switched off there is nothing to order.
  const off = await scenario({
    withExpressions: false,
    fluxerOpts: { extraRoles: [BOSS] },
    options: { roles: false },
  });
  assert.equal((await off.engine.previewPair(off.pair)).ok, true);
});

test('role ranks on Fluxer follow Discord, even for a tie, and a Manage Roles role never outranks the Administrator role', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).rawPosition = 1; // a tie with Member
  s.discord.roles.cache.get(s.k.member).permissions = { bitfield: MANAGE_ROLES };
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const [sent] = s.fluxer.ops('setRolePositions');
  assert.equal(new Set(sent.updates.map((u) => u.position)).size, 2, 'no two roles share a position');
  const member = s.fluxer.guild.roles.get(await mapped(s, 'role', s.k.member));
  const mod = s.fluxer.guild.roles.get(await mapped(s, 'role', s.k.mod));
  assert.ok(mod.position > member.position, 'the Administrator role ranks above the Manage Roles role');
  assert.ok(s.fluxer.guild.roles.get(SYLO_ROLE).position > mod.position);
});

test('a role gets its powerful permissions only after its place in the order is set', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.member).permissions = { bitfield: MANAGE_ROLES | BIT.ViewChannel };
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator | BIT.ViewChannel };
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.equal(end.status, 'live');
  const calls = s.fluxer.calls;
  const member = await mapped(s, 'role', s.k.member);
  const mod = await mapped(s, 'role', s.k.mod);
  const made = (id) => calls.findIndex((c) => c.op === 'createRole' && c.id === id);
  const ordered = calls.findIndex((c) => c.op === 'setRolePositions');
  const granted = (id) => calls.findIndex((c) => c.op === 'editRole' && c.id === id);
  for (const id of [member, mod]) {
    const created = calls[made(id)].spec;
    assert.equal(
      BigInt(created.permissions) & (ADMIN | MANAGE_ROLES),
      0n,
      'made without powerful permissions'
    );
    assert.ok(made(id) < ordered && ordered < granted(id), 'created, then ordered, then granted');
  }
  assert.equal(roleBits(s, member) & MANAGE_ROLES, MANAGE_ROLES);
  assert.equal(roleBits(s, mod) & ADMIN, ADMIN);
  assert.ok(
    (await db.getMapping(s.pair.id, 'role', s.k.mod)).specHash,
    'and the role is fingerprinted when final'
  );
});

test('a single role is ordered too, so that it gets its permissions', async () => {
  const s = await scenario({ withExpressions: false });
  for (const id of [s.k.member, s.k.bot]) s.discord.roles.cache.delete(id);
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.equal(s.fluxer.ops('setRolePositions').length, 1);
  assert.equal(roleBits(s, await mapped(s, 'role', s.k.mod)) & ADMIN, ADMIN);
});

test('with a new powerful role and a role above Sylo, the mirror pauses and the role stays without its permissions', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  s.fluxer.calls.length = 0;
  s.fluxer.guild.roles.set(BOSS.id, { _permissions: '0', managed: false, ...BOSS }); // someone moved a role above Sylo
  const id = '780000000000000001';
  s.discord.roles.cache.set(id, {
    id,
    name: 'New admin',
    color: 0,
    rawPosition: 5,
    hoist: false,
    mentionable: false,
    managed: false,
    permissions: { bitfield: BIT.Administrator },
  });
  await s.engine.noteSourceChange(s.k.src, { kind: 'role', op: 'sync', id, reorder: 'roles' });
  s.clock.now += 4000;
  await s.engine.runPair(s.pair.id);
  const pair = await db.getPair(s.pair.id);
  assert.deepEqual([pair.status, pair.pauseKind], ['paused', 'hierarchy']);
  assert.match(pair.lastError, /Admins/);
  assert.equal(s.fluxer.ops('setRolePositions').length, 0, 'nothing was reordered');
  const made = s.fluxer.ops('createRole')[0];
  assert.equal(BigInt(made.spec.permissions) & ADMIN, 0n);
  assert.equal(roleBits(s, made.id) & ADMIN, 0n, 'it stays without Administrator while the order is not set');

  // The Fluxer owner moves Sylo's role to the top; the mirror resumes, orders, and only then grants.
  s.fluxer.guild.roles.delete(BOSS.id);
  await s.engine.resume(s.pair.id, { side: 'source' });
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('setRolePositions').length, 1);
  assert.equal(roleBits(s, made.id) & ADMIN, ADMIN);
});

test('asking for real deletion needs the Fluxer owner; resuming with deletes waiting shows what they are', async () => {
  const s = await scenario({ options: { mirrorDeletes: true } });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  await s.engine.pause(s.pair.id); // paused by hand, not by the brake
  const note = (kind, id) => s.engine.noteSourceChange(s.k.src, { kind, op: 'delete', id });
  for (const id of [s.k.chat, s.k.rules, s.k.voice, s.k.cat, s.k.cat2]) {
    s.discord.channels.cache.delete(id);
    await note('channel', id);
  }
  s.discord.emojis.cache.delete(s.k.emoji1);
  await note('emoji', s.k.emoji1);
  assert.equal(
    (await db.getPair(s.pair.id)).pauseKind,
    'owner',
    'deletes while paused do not change the pause'
  );
  await assert.rejects(s.engine.resume(s.pair.id, { side: 'target' }), (e) => {
    assert.equal(e.code, 'confirm-needed');
    assert.equal(e.deleteCount, 6);
    return true;
  });
  const progress = await s.engine.progress(await db.getPair(s.pair.id));
  assert.equal(progress.pendingDeletes.length, 6, 'the page can show what will be deleted');
  assert.equal((await s.engine.resume(s.pair.id, { side: 'target', confirm: true })).status, 'live');
});

test('with roles off, a channel @everyone cannot see on Discord is still private on Fluxer', async () => {
  const s = await scenario({
    withExpressions: false,
    options: { roles: false },
    discordOpts: { everyonePermissions: 0n },
  });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const made = s.fluxer.ops('createChannel');
  assert.equal(made.length, 5);
  for (const c of made) {
    const own = c.spec.permissionOverwrites.find((o) => o.id === s.fluxer.guild.id);
    assert.ok(own && (BigInt(own.deny) & view) === view, `${c.spec.name} denies View Channel to @everyone`);
  }
});

test('when the @everyone step fails, private channels are still private', async () => {
  const s = await scenario({ withExpressions: false, discordOpts: { everyonePermissions: 0n } });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('editRole', Object.assign(new Error('Invalid Form Body'), { statusCode: 400 }), 1);
  assert.equal((await drain(s)).status, 'live');
  const everyone = (await db.listFailedJobs(s.pair.id)).find((j) => j.kind === 'role');
  assert.ok(everyone, 'the @everyone step failed');
  for (const c of s.fluxer.ops('createChannel')) {
    const own = c.spec.permissionOverwrites.find((o) => o.id === s.fluxer.guild.id);
    assert.ok(own && (BigInt(own.deny) & view) === view, `${c.spec.name} stays hidden`);
  }
});

test('copied settings do not hand out a powerful role or start pinging everyone', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  s.discord.roles.cache.get(s.k.member).permissions = { bitfield: BIT.ViewChannel };
  await setGuildModule(s.k.src, 'roles', { enabled: true, config: { autoroles: [s.k.mod, s.k.member] } });
  await setGuildModule(s.k.src, 'giveaways', {
    enabled: true,
    config: { ping: 'everyone', channel: s.k.chat },
  });
  await setGuildModule(s.k.src, 'apple-connect', { enabled: true, config: { channelId: s.k.chat } });
  const preview = await s.engine.previewPair(s.pair);
  assert.equal(
    preview.steps.some((x) => x.key === 'module:apple-connect'),
    false,
    "the operator's own modules are never copied"
  );
  const codes = preview.notes.map((n) => n.code);
  assert.ok(codes.includes('module-grant-dropped') && codes.includes('module-ping-lowered'));
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  const roles = await getGuildModule(`fluxer:${s.k.dst}`, 'roles');
  assert.deepEqual(
    roles.config.autoroles,
    [await mapped(s, 'role', s.k.member)],
    'the Administrator role is not an autorole'
  );
  const giveaways = await getGuildModule(`fluxer:${s.k.dst}`, 'giveaways');
  assert.equal(giveaways.config.ping, 'none');
  assert.equal(giveaways.config.channel, await mapped(s, 'channel', s.k.chat));
  const report = await s.engine.report(end);
  assert.deepEqual(
    report.notes
      .filter((n) => n.code.startsWith('module-'))
      .map((n) => n.code)
      .sort(),
    ['module-grant-dropped', 'module-ids-dropped', 'module-ping-lowered']
  );
  assert.deepEqual((await getGuildModule(`fluxer:${s.k.dst}`, 'apple-connect')).config, {});
});

test('a failed edit or look-up never makes a second copy', async () => {
  const s = await scenario();
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  s.fluxer.calls.length = 0;
  const chat = await mapped(s, 'channel', s.k.chat);
  s.discord.channels.cache.get(s.k.chat).name = 'chatter';
  s.fluxer.failOn('editChannel', Object.assign(new Error('unavailable'), { statusCode: 503 }), 1);
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.chat });
  await s.engine.runPair(s.pair.id);
  assert.equal(await mapped(s, 'channel', s.k.chat), chat, 'the copy is still known');
  assert.equal(s.fluxer.ops('createChannel').length, 0, 'and no second one was made');
  s.clock.now += 5000;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('createChannel').length, 0);
  assert.equal(s.fluxer.guild.channels.get(chat).name, 'chatter', 'the retry updated the same channel');
});

test('a role whose second call fails is tracked, and the retry updates it instead of making another', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failAfterCreate('createRole', Object.assign(new Error('timed out'), { statusCode: 503 }));
  assert.equal((await drain(s)).status, 'live');
  assert.equal(s.fluxer.ops('createRole').length, 2, 'Member and Mod: one create each');
  assert.equal([...s.fluxer.guild.roles.values()].length, 4, 'and so four roles with @everyone and Sylo');
  const member = await db.getMapping(s.pair.id, 'role', s.k.member);
  assert.equal(member.owned, true);
  assert.ok(member.specHash, 'the retry updated it, so it is fingerprinted now');
  assert.ok(s.fluxer.ops('editRole').some((c) => c.id === member.targetId));
});

test('a job that may have gone through before a timeout looks for what it made before it makes anything', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  // The create reaches Fluxer but the answer is lost.
  const real = s.fluxer.target.createChannel;
  let lost = false;
  s.fluxer.target.createChannel = async (spec) => {
    const id = await real(spec);
    if (!lost && spec.name === 'chat') {
      lost = true;
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    }
    return id;
  };
  assert.equal((await drain(s)).status, 'live');
  assert.equal(
    [...s.fluxer.guild.channels.values()].filter((c) => c.name === 'chat').length,
    1,
    'one chat channel'
  );
  assert.equal(
    (await db.getMapping(s.pair.id, 'channel', s.k.chat)).owned,
    false,
    'adopted, never deleted by Sylo'
  );
});

test('after a crash a job adopts only what was made since it started, never something older', async () => {
  const foreign = { id: '760000000000000010', name: 'chat', type: 0, parentId: null };
  const s = await scenario({ withExpressions: false, fluxerOpts: { existingChannels: [foreign] } });
  await s.engine.startCopy(s.pair.id);
  for (;;) {
    const job = await db.nextDueJob(s.pair.id, s.clock.now);
    if (job.kind === 'channel' && job.sourceId === s.k.chat) break;
    await s.engine.runPair(s.pair.id, { maxJobs: 1 });
  }
  const job = await db.nextDueJob(s.pair.id, s.clock.now);
  assert.equal(await db.claimJob(job.id, s.clock.now), true);
  const { engine } = engineFor({ discord: s.discord, fluxer: s.fluxer, clock: s.clock });
  await engine.resumeAfterRestart();
  s.engine = engine;
  assert.equal((await drain(s)).status, 'live');
  assert.ok(
    s.fluxer.ops('createChannel').some((c) => c.spec.name === 'chat'),
    'a new chat channel was made'
  );
  assert.equal(
    s.fluxer.ops('editChannel').some((c) => c.id === foreign.id),
    false,
    'the older one was left alone'
  );
});

test("only one side's owner can resume what that side paused", async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  await s.engine.pause(s.pair.id, 'source');
  await assert.rejects(s.engine.resume(s.pair.id, { side: 'target' }), /only that owner can resume/);
  assert.equal((await s.engine.resume(s.pair.id, { side: 'source' })).status, 'live');
  await s.engine.pause(s.pair.id, 'target');
  assert.equal((await s.engine.resume(s.pair.id, { side: 'target' })).status, 'live');
});

test('a server marked age-restricted gives every copied channel the age flag', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.nsfwLevel = 3;
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const text = s.fluxer.ops('createChannel').filter((c) => c.spec.type === 0);
  assert.ok(text.length > 0 && text.every((c) => c.spec.nsfw === true));
});

test('only a few mirrors are worked at once', async () => {
  const a = await scenario({ withExpressions: false });
  const b = await scenario({ withExpressions: false });
  const engine = createEngine({
    now: a.clock.fn,
    sleep: a.clock.sleep,
    minIntervalMs: 1,
    maxWorkers: 1,
    clientsReady: () => true,
    enforceOwnership: () => false,
    sourceGuild: (key) => [a, b].map((x) => x.discord).find((d) => d.id === key),
    targetGuild: (key) => [a, b].map((x) => x.fluxer.guild).find((g) => `fluxer:${g.id}` === key),
    makeTarget: (guild) => [a, b].map((x) => x.fluxer).find((f) => f.guild === guild).target,
    fetchImage: async () => ({ bytes: Buffer.alloc(8), mime: 'image/png' }),
  });
  // Pairs of the other tests in this file must not take the worker slots.
  for (const p of await db.listAllPairs()) {
    if (![a.pair.id, b.pair.id].includes(p.id)) await db.updatePair(p.id, { status: 'stopped' });
  }
  await engine.startCopy(a.pair.id);
  await engine.startCopy(b.pair.id);
  await engine.tick();
  assert.equal([a, b].filter((x) => engine.isRunning(x.pair.id)).length, 1, 'one worker at a time');
  for (let i = 0; i < 400; i += 1) {
    await engine.tick();
    await new Promise((r) => setImmediate(r));
    const states = await Promise.all([a, b].map((x) => db.getPair(x.pair.id)));
    if (states.every((p) => p.status === 'live')) break;
  }
  assert.equal((await db.getPair(a.pair.id)).status, 'live');
  assert.equal((await db.getPair(b.pair.id)).status, 'live');
});

test('old copy runs are pruned when a new one starts', async () => {
  const s = await scenario({ withExpressions: false });
  for (let i = 0; i < 3; i += 1) {
    await s.engine.startCopy(s.pair.id);
    await drain(s);
  }
  const pair = await db.getPair(s.pair.id);
  assert.equal(pair.copyRun, 3);
  assert.equal((await db.listRunJobs(pair.id, 1)).length, 0, 'run 1 is gone');
  assert.ok((await db.listRunJobs(pair.id, 2)).length > 0, 'the run before the latest is kept');
});

test('a Discord emoji or sticker delete that arrives while its copy is still being made is not lost', async () => {
  const s = await scenario();
  await s.engine.startCopy(s.pair.id);
  s.discord.emojis.cache.delete(s.k.emoji1);
  // The copy of the emoji has not been made yet, so there is no copy to find when the delete is noted.
  assert.equal(
    await s.engine.noteSourceChange(s.k.src, { kind: 'emoji', op: 'delete', id: s.k.emoji1 }),
    true
  );
  await drain(s);
  assert.equal(s.fluxer.ops('createEmoji').length, 1, 'the deleted emoji was never made');
});

test('a copied economy comes over switched off, with a note', async () => {
  const s = await scenario({ withExpressions: false });
  await setGuildModule(s.k.src, 'economy', { enabled: true, config: { startingBalance: 100 } });
  const preview = await s.engine.previewPair(s.pair);
  assert.ok(preview.notes.some((n) => n.code === 'module-economy-off'));
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const there = await getGuildModule(`fluxer:${s.k.dst}`, 'economy');
  assert.equal(there.enabled, false);
  assert.equal(there.config.startingBalance, 100, 'the settings are there for its owner to look at');
});

test('a mirrored Administrator role deleted on Fluxer is made again without its permissions, ordered, then granted', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator | BIT.ViewChannel };
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const first = await mapped(s, 'role', s.k.mod);
  assert.equal(roleBits(s, first) & ADMIN, ADMIN, 'the first copy granted it');

  // Somebody deletes the role on Fluxer; it is edited on Discord, so the mirror syncs it.
  s.fluxer.guild.roles.delete(first);
  s.discord.roles.cache.get(s.k.mod).name = 'Moderators';
  s.fluxer.calls.length = 0;
  await s.engine.noteSourceChange(s.k.src, { kind: 'role', op: 'sync', id: s.k.mod });
  await s.engine.runPair(s.pair.id);

  const again = await mapped(s, 'role', s.k.mod);
  assert.notEqual(again, first, 'a new role was made');
  const calls = s.fluxer.calls;
  const made = calls.findIndex((c) => c.op === 'createRole');
  const ordered = calls.findIndex((c) => c.op === 'setRolePositions');
  const granted = calls.findIndex((c) => c.op === 'editRole' && c.id === again);
  assert.ok(made >= 0 && made < ordered && ordered < granted, 'made, then ordered, then granted');
  assert.equal(BigInt(calls[made].spec.permissions) & ADMIN, 0n, 'made without Administrator');
  assert.equal(roleBits(s, again) & ADMIN, ADMIN, 'and granted at the end');
  assert.ok((await db.getMapping(s.pair.id, 'role', s.k.mod)).specHash, 'final');
  assert.ok(s.fluxer.guild.roles.get(SYLO_ROLE).position > s.fluxer.guild.roles.get(again).position);
});

test('a role adopted after a crash waits for the order too, and gets its permissions after it', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  await s.engine.startCopy(s.pair.id);
  for (;;) {
    const job = await db.nextDueJob(s.pair.id, s.clock.now);
    if (job.kind === 'role' && job.sourceId === s.k.mod) break;
    await s.engine.runPair(s.pair.id, { maxJobs: 1 });
  }
  const job = await db.nextDueJob(s.pair.id, s.clock.now);
  assert.equal(await db.claimJob(job.id, s.clock.now), true);
  // The dead run made the role with everything it asked for, but never wrote it down.
  const madeId = await s.fluxer.target.createRole({
    name: 'Mod',
    color: 0,
    hoist: false,
    mentionable: true,
    permissions: String(ADMIN),
  });
  const { engine } = engineFor({ discord: s.discord, fluxer: s.fluxer, clock: s.clock });
  await engine.resumeAfterRestart();
  s.engine = engine;
  s.fluxer.calls.length = 0;
  assert.equal((await drain(s)).status, 'live');
  const adopted = await db.getMapping(s.pair.id, 'role', s.k.mod);
  assert.deepEqual([adopted.targetId, adopted.owned], [madeId, false]);
  const edits = s.fluxer.ops('editRole').filter((c) => c.id === madeId);
  const ordered = s.fluxer.calls.findIndex((c) => c.op === 'setRolePositions');
  assert.equal(BigInt(edits[0].spec.permissions) & ADMIN, 0n, 'first stripped');
  assert.equal(roleBits(s, madeId) & ADMIN, ADMIN, 'and granted after the order');
  assert.ok(s.fluxer.calls.indexOf(edits.at(-1)) > ordered);
  assert.ok(adopted.specHash || (await db.getMapping(s.pair.id, 'role', s.k.mod)).specHash);
});
