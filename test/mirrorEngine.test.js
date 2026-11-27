// The mirror engine (src/mirror/engine.js) against a fake Discord server and a fake Fluxer adapter: the dry run
// equals the copy, a copy survives a restart and a crash, changes on Discord follow, Sylo never deletes what it did
// not create, and trouble with Fluxer is spaced out, backed off and, when it keeps up, pauses the pair.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { createEngine } from '../src/mirror/engine.js';
import { linkMirroredChannels } from '../src/mirror/bridgeLink.js';
import { dChannel, engineFor } from './helpers/mirrorFakes.js';
import { drain, names, scenario } from './helpers/mirrorScenario.js';

/** Let the checks tick() starts without waiting for them run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the dry run creates nothing and lists everything with what cannot be carried over', async () => {
  const s = await scenario();
  const preview = await s.engine.previewPair(s.pair);
  assert.equal(preview.ok, true);
  assert.equal(s.fluxer.calls.length, 0, 'a preview never writes to Fluxer');
  assert.equal(s.fetched.length, 0, 'and downloads nothing');
  assert.deepEqual(
    preview.summary.role,
    { create: 2, update: 1, unchanged: 0, skip: 1 },
    'Member, Mod; @everyone is updated; the bot role is skipped'
  );
  assert.deepEqual(preview.summary.channel, { create: 5, update: 0, unchanged: 0, skip: 0 });
  assert.deepEqual(preview.summary.emoji, { create: 2, update: 0, unchanged: 0, skip: 0 });
  assert.deepEqual(preview.summary.sticker, { create: 1, update: 0, unchanged: 0, skip: 1 });
  const codes = new Set(preview.notes.map((x) => x.code));
  for (const code of ['permissions-dropped', 'managed-role', 'sticker-lottie'])
    assert.ok(codes.has(code), code);
  assert.equal(preview.steps.at(-1).kind, 'bridge');
  assert.equal(preview.steps[0].kind, 'guild');
  // categories before the channels in them, roles before channels
  const order = preview.steps.map((x) => x.key);
  assert.ok(order.indexOf(`role:${s.k.member}`) < order.indexOf(`channel:${s.k.rules}`));
  assert.ok(order.indexOf(`channel:${s.k.cat}`) < order.indexOf(`channel:${s.k.rules}`));
});

test('dry run equals real run: the same things, in the same order, with the same specs and notes', async () => {
  const s = await scenario();
  const preview = await s.engine.previewPair(s.pair);
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.equal(end.status, 'live');
  const report = await s.engine.report(end);

  const planned = (kind, op) => preview.steps.filter((x) => x.kind === kind && x.op === op);
  assert.equal(s.fluxer.ops('createRole').length, planned('role', 'create').length);
  assert.equal(s.fluxer.ops('createChannel').length, planned('channel', 'create').length);
  assert.equal(s.fluxer.ops('createEmoji').length, planned('emoji', 'create').length);
  assert.equal(s.fluxer.ops('createSticker').length, planned('sticker', 'create').length);
  assert.deepEqual(
    names(s.fluxer.ops('createChannel')),
    planned('channel', 'create').map((x) => x.name),
    'channels are made in the order the preview showed'
  );
  assert.deepEqual(
    names(s.fluxer.ops('createRole')),
    planned('role', 'create').map((x) => x.name)
  );

  // The preview's spec, with its placeholders resolved through the id map, is what was sent.
  const resolve = async (kind, id) =>
    id === 'everyone' ? s.fluxer.guild.id : (await db.getMapping(s.pair.id, kind, id)).targetId;
  for (const step of planned('channel', 'create')) {
    const madeId = (await db.getMapping(s.pair.id, 'channel', step.sourceId)).targetId;
    const sent = s.fluxer.ops('createChannel').find((c) => c.id === madeId);
    assert.equal(sent.spec.name, step.spec.name);
    assert.equal(sent.spec.type, step.spec.type);
    assert.equal(sent.spec.topic ?? null, step.spec.topic ?? null);
    const wantParent = step.spec.parentId ? await resolve('channel', step.spec.parentId.split(':')[1]) : null;
    assert.equal(sent.spec.parentId, wantParent);
    const wantOverwrites = [];
    for (const o of step.spec.permissionOverwrites) {
      wantOverwrites.push({
        id: await resolve('role', o.id.split(':')[1]),
        type: 0,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      });
    }
    assert.deepEqual(
      sent.spec.permissionOverwrites.map((o) => ({
        id: o.id,
        type: o.type,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      })),
      wantOverwrites
    );
  }

  const key = (x) => `${x.code}|${x.ref.id}|${x.message}`;
  assert.deepEqual(
    report.notes.map(key).sort(),
    preview.notes.map(key).sort(),
    'the report lists what the preview listed'
  );

  // Run again: everything is unchanged, so a second preview plans nothing to create.
  const again = await s.engine.previewPair(end);
  for (const kind of ['role', 'channel', 'emoji', 'sticker'])
    assert.equal(again.summary[kind].create, 0, kind);
  assert.equal(again.summary.channel.unchanged, 5);
});

test('a copy sends what the server has: ids remapped, @everyone adopted, settings carried over', async () => {
  const s = await scenario();
  const welcome = {
    joinEnabled: true,
    joinChannel: s.k.chat,
    joinMessage: 'Hi, read <#' + s.k.rules + '>',
    autoRole: s.k.member,
    panelMessageId: '999999999999999999',
    userId: '123456789012345678',
  };
  await setGuildModule(s.k.src, 'welcome', { enabled: true, config: welcome });
  await setGuildModule(s.k.src, 'logging', { enabled: true, config: { channel: s.k.bot } });
  await setGuildModule(`fluxer:${s.k.dst}`, 'logging', { enabled: false, config: { channel: '1' } });
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.equal(end.status, 'live');
  const map = async (kind, id) => (await db.getMapping(s.pair.id, kind, id)).targetId;

  const category = s.fluxer.ops('createChannel').find((c) => c.spec.name === 'Info');
  const rules = s.fluxer.ops('createChannel').find((c) => c.spec.name === 'rules');
  assert.equal(rules.spec.parentId, category.id);
  assert.deepEqual(
    rules.spec.permissionOverwrites.map((o) => o.id).sort(),
    [await map('role', s.k.member), s.fluxer.guild.id].sort()
  );
  const everyone = await db.getMapping(s.pair.id, 'role', s.k.src);
  assert.deepEqual([everyone.targetId, everyone.owned], [s.fluxer.guild.id, false]);
  const edit = s.fluxer.ops('editRole').find((c) => c.id === s.fluxer.guild.id);
  assert.ok(
    BigInt(edit.spec.permissions) & (1n << 53n),
    'the Fluxer-only permission @everyone already had is kept'
  );

  const there = await getGuildModule(`fluxer:${s.k.dst}`, 'welcome');
  assert.equal(there.enabled, true);
  assert.equal(there.config.joinChannel, await map('channel', s.k.chat));
  assert.equal(there.config.joinMessage, `Hi, read <#${await map('channel', s.k.rules)}>`);
  assert.equal(there.config.autoRole, await map('role', s.k.member));
  assert.equal(there.config.panelMessageId, '', 'the id of a message that is not copied is cleared');
  assert.equal(there.config.userId, '', 'the id of a person means nothing on Fluxer');
  assert.deepEqual(
    (await getGuildModule(`fluxer:${s.k.dst}`, 'logging')).config,
    { channel: '1' },
    'settings already on the Fluxer server are not overwritten'
  );
  const report = await s.engine.report(end);
  assert.ok(
    report.items.some((i) => i.kind === 'module' && i.name === 'Server logging' && i.status === 'skipped')
  );

  assert.deepEqual(
    s.fluxer.ops('editGuild').map((c) => c.body.name),
    ['Source'],
    'the name is copied'
  );
  assert.match(s.fluxer.ops('editGuild')[0].body.icon, /^data:image\/png;base64,/);
  assert.equal(s.fluxer.ops('createEmoji').length, 2);
  assert.equal(s.fluxer.ops('createSticker').length, 1, 'the Lottie sticker is left out');
  assert.equal(s.fluxer.ops('setRolePositions').length, 1);
  assert.equal(s.fluxer.ops('setChannelPositions').length, 1);
});

test('the last step, linking through the bridge, says why it linked nothing when the platforms are not both up', async () => {
  assert.equal((await linkMirroredChannels(999_999)).reason, 'no-such-mirror');
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  const report = await s.engine.report(end);
  assert.equal(report.bridge.status, 'done');
  assert.match(report.bridge.detail, /bridge-not-available/);
  let calledWith = null;
  const linked = await scenario({
    withExpressions: false,
    engineOpts: { linkMirroredChannels: async (id) => ((calledWith = id), { linked: 3 }) },
  });
  await linked.engine.startCopy(linked.pair.id);
  const done = await drain(linked);
  assert.equal(calledWith, linked.pair.id);
  assert.match((await linked.engine.report(done)).bridge.detail, /3 channels linked/);
});

test('a copy resumes after a restart without making anything twice', async () => {
  const s = await scenario();
  await s.engine.startCopy(s.pair.id);
  await s.engine.runPair(s.pair.id, { maxJobs: 6 });
  const before = await s.engine.progress(await db.getPair(s.pair.id));
  assert.ok(before.done > 0 && before.waiting > 0, 'stopped half way');
  assert.equal((await db.getPair(s.pair.id)).status, 'copying');

  // A new process: a new engine, the same database and servers.
  const { engine: second } = engineFor({ discord: s.discord, fluxer: s.fluxer, clock: s.clock });
  await second.resumeAfterRestart();
  s.engine = second;
  const end = await drain(s);
  assert.equal(end.status, 'live');
  const created = names(s.fluxer.ops('createChannel'));
  assert.equal(new Set(created).size, created.length, 'no channel was made twice');
  assert.equal(created.length, 5);
  assert.equal(s.fluxer.ops('createRole').length, 2);
  const progress = await second.progress(end);
  assert.deepEqual([progress.waiting, progress.percent], [0, 100]);
});

test('a job that was running when the process died adopts what it made, and never owns it', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  // Work until the next job is the "rules" channel.
  for (;;) {
    const job = await db.nextDueJob(s.pair.id, s.clock.now);
    if (job.kind === 'channel' && job.sourceId === s.k.rules) break;
    await s.engine.runPair(s.pair.id, { maxJobs: 1 });
  }
  const job = await db.nextDueJob(s.pair.id, s.clock.now);
  const parent = (await db.getMapping(s.pair.id, 'channel', s.k.cat)).targetId;
  // The dead process claimed the job and created the channel on Fluxer, but never wrote the id map.
  assert.equal(await db.claimJob(job.id, s.clock.now), true);
  const madeId = await s.fluxer.target.createChannel({
    name: 'rules',
    type: 0,
    parentId: parent,
    permissionOverwrites: [],
  });
  s.fluxer.calls.length = 0;

  const { engine: second } = engineFor({ discord: s.discord, fluxer: s.fluxer, clock: s.clock });
  await second.resumeAfterRestart();
  s.engine = second;
  const end = await drain(s);
  assert.equal(end.status, 'live');
  assert.equal(
    s.fluxer.ops('createChannel').filter((c) => c.spec.name === 'rules').length,
    0,
    'it was not made a second time'
  );
  const m = await db.getMapping(s.pair.id, 'channel', s.k.rules);
  assert.deepEqual([m.targetId, m.owned], [madeId, false]);
  assert.equal([...s.fluxer.guild.channels.values()].filter((c) => c.name === 'rules').length, 1);
});

test('changes on Discord follow: rename, create, delete, reorder; a burst of events is one job', async () => {
  const s = await scenario({ options: { mirrorDeletes: true } });
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');
  s.fluxer.calls.length = 0;
  const target = async (kind, id) => (await db.getMapping(s.pair.id, kind, id)).targetId;
  const note = (change) => s.engine.noteSourceChange(s.k.src, change);

  s.discord.channels.cache.get(s.k.chat).name = 'chatter';
  assert.equal(await note({ kind: 'channel', op: 'sync', id: s.k.chat }), true);
  for (let i = 0; i < 4; i += 1)
    assert.equal(await note({ kind: 'channel', op: 'sync', id: s.k.chat }), false, 'already waiting');
  assert.equal(await db.openSyncCount(s.pair.id), 1);

  const newId = '750000000000000001';
  s.discord.channels.cache.set(
    newId,
    dChannel({ id: newId, name: 'new-one', type: 0, parentId: s.k.cat, rawPosition: 9 })
  );
  await note({ kind: 'channel', op: 'sync', id: newId, reorder: 'channels' });
  s.discord.roles.cache.get(s.k.mod).name = 'Moderators';
  await note({ kind: 'role', op: 'sync', id: s.k.mod });
  s.discord.emojis.cache.set('750000000000000002', {
    id: '750000000000000002',
    name: 'fresh',
    animated: false,
    managed: false,
    imageURL: () => 'https://cdn.test/f.png',
  });
  await note({ kind: 'emoji', op: 'sync', id: '750000000000000002' });
  const goneTarget = await target('emoji', s.k.emoji1);
  s.discord.emojis.cache.delete(s.k.emoji1);
  await note({ kind: 'emoji', op: 'delete', id: s.k.emoji1 });

  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer.ops('editChannel').map((c) => c.spec.name),
    ['chatter']
  );
  assert.deepEqual(names(s.fluxer.ops('createChannel')), ['new-one']);
  assert.equal(s.fluxer.ops('createChannel')[0].spec.parentId, await target('channel', s.k.cat));
  assert.deepEqual(
    s.fluxer.ops('editRole').map((c) => c.spec.name),
    ['Moderators']
  );
  assert.deepEqual(
    s.fluxer.ops('createEmoji').map((c) => c.name),
    ['fresh']
  );
  assert.deepEqual(
    s.fluxer.ops('deleteEmoji').map((c) => c.id),
    [goneTarget]
  );
  assert.equal(await db.getMapping(s.pair.id, 'emoji', s.k.emoji1), null);
  assert.equal(
    s.fluxer.ops('setChannelPositions').length,
    0,
    'the reorder waits a moment so a drag is one reorder'
  );
  s.clock.now += 4000;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('setChannelPositions').length, 1);

  // A delete on Discord removes the Fluxer copy; a rename in between is dropped.
  const chatTarget = await target('channel', s.k.chat);
  s.discord.channels.cache.delete(s.k.chat);
  await note({ kind: 'channel', op: 'sync', id: s.k.chat });
  await note({ kind: 'channel', op: 'delete', id: s.k.chat });
  s.fluxer.calls.length = 0;
  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer.ops('deleteChannel').map((c) => c.id),
    [chatTarget]
  );
  assert.equal(s.fluxer.ops('editChannel').length, 0);
  assert.equal(s.fluxer.guild.channels.has(chatTarget), false);
});

test('Sylo never deletes a Fluxer item it did not create', async () => {
  const foreign = { id: '760000000000000001', name: 'general', type: 0, parentId: null };
  const mine = { id: '760000000000000002', name: 'rules', type: 0, parentId: null };
  const s = await scenario({
    fluxerOpts: { existingChannels: [foreign, mine] },
    withExpressions: false,
    options: { mirrorDeletes: true },
  });
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');
  assert.ok(s.fluxer.guild.channels.has(foreign.id), 'a channel that was already there stays');
  assert.ok(s.fluxer.guild.channels.has(mine.id), 'even one with the same name as a copied channel');
  assert.equal(
    s.fluxer.ops('createChannel').filter((c) => c.spec.name === 'rules').length,
    1,
    'a copy is made next to it'
  );

  const note = (change) => s.engine.noteSourceChange(s.k.src, change);
  // Deleting things on Discord that Sylo never copied does nothing on Fluxer.
  assert.equal(
    await note({ kind: 'channel', op: 'delete', id: '760000000000000099' }),
    true,
    'queued; the job finds no copy'
  );
  assert.equal(
    await note({ kind: 'role', op: 'delete', id: s.k.bot }),
    true,
    'a role that was skipped has no copy'
  );
  // An item the id map holds as not owned is forgotten, never deleted.
  await db.putMapping({
    pairId: s.pair.id,
    kind: 'channel',
    sourceId: '760000000000000050',
    targetId: foreign.id,
    owned: false,
  });
  assert.equal(await note({ kind: 'channel', op: 'delete', id: '760000000000000050' }), true);
  // Deleting the @everyone mapping (adopted) the same way.
  await db.putMapping({
    pairId: s.pair.id,
    kind: 'role',
    sourceId: '760000000000000051',
    targetId: s.fluxer.guild.id,
    owned: false,
  });
  assert.equal(await note({ kind: 'role', op: 'delete', id: '760000000000000051' }), true);
  s.fluxer.calls.length = 0;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('deleteChannel').length, 0);
  assert.equal(s.fluxer.ops('deleteRole').length, 0);
  assert.ok(s.fluxer.guild.channels.has(foreign.id));
  assert.ok(s.fluxer.guild.roles.has(s.fluxer.guild.id));
  assert.equal(
    await db.getMapping(s.pair.id, 'channel', '760000000000000050'),
    null,
    'the mapping is dropped'
  );
  // What Sylo did create is deleted when its original goes.
  const mineOnFluxer = (await db.getMapping(s.pair.id, 'channel', s.k.rules)).targetId;
  assert.notEqual(mineOnFluxer, mine.id);
  s.discord.channels.cache.delete(s.k.rules);
  await note({ kind: 'channel', op: 'delete', id: s.k.rules });
  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer.ops('deleteChannel').map((c) => c.id),
    [mineOnFluxer]
  );
  assert.ok(s.fluxer.guild.channels.has(mine.id));
});

test('mirroring is one way: a change made on Fluxer is not read back, and only Discord is ever read', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const chat = (await db.getMapping(s.pair.id, 'channel', s.k.chat)).targetId;
  s.fluxer.guild.channels.get(chat).name = 'renamed-on-fluxer';
  s.fluxer.calls.length = 0;
  // Nothing on Fluxer is watched: no job exists until Discord changes.
  await s.engine.tick();
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.calls.length, 0);
  // The next change on Discord overwrites it.
  s.discord.channels.cache.get(s.k.chat).topic = 'new topic';
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.chat });
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.guild.channels.get(chat).name, 'chat');
});

test('changes are not queued unless a mirror is running for that server, and continuous mirroring is on', async () => {
  const s = await scenario({ withExpressions: false, options: { continuous: false } });
  const change = { kind: 'channel', op: 'sync', id: s.k.chat };
  assert.equal(await s.engine.noteSourceChange(s.k.src, change), false, 'agreed but not copied yet');
  await s.engine.startCopy(s.pair.id);
  assert.equal(
    (await drain(s)).status,
    'done',
    'with continuous mirroring off the pair is done after the copy'
  );
  assert.equal(await s.engine.noteSourceChange(s.k.src, change), false);
  assert.equal(
    await s.engine.noteSourceChange('930000000000999999', change),
    false,
    'another server has no pair'
  );
  await db.updatePair(s.pair.id, {
    status: 'live',
    options: { ...s.pair.options, channels: false, continuous: true },
  });
  assert.equal(await s.engine.noteSourceChange(s.k.src, change), false, 'channels are turned off');
  await db.updatePair(s.pair.id, { options: { continuous: true } });
  assert.equal(await s.engine.noteSourceChange(s.k.src, change), true);
});

test('pausing keeps changes for later; stopping drops the work and the consent', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  await s.engine.pause(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).status, 'paused');
  s.discord.channels.cache.get(s.k.chat).name = 'while-paused';
  assert.equal(await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.chat }), true);
  s.fluxer.calls.length = 0;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.calls.length, 0, 'a paused mirror does nothing');
  await s.engine.resume(s.pair.id);
  await s.engine.runPair(s.pair.id);
  assert.deepEqual(
    s.fluxer.ops('editChannel').map((c) => c.spec.name),
    ['while-paused']
  );

  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.rules });
  const stopped = await s.engine.stopPair(s.pair.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.sourceConsentBy, '');
  assert.equal(await db.openSyncCount(s.pair.id), 0);
  assert.equal(
    await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.rules }),
    false
  );
  await assert.rejects(s.engine.startCopy(s.pair.id), /agree/);
  assert.equal(await s.engine.removePair(s.pair.id), true);
  assert.equal(await db.getPair(s.pair.id), null);
});

test('Fluxer asking to slow down: the job waits as long as asked, then goes on', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('createRole', Object.assign(new Error('rate limited'), { statusCode: 429, retryAfter: 4 }));
  await s.engine.runPair(s.pair.id);
  const waiting = (await db.listRunJobs(s.pair.id, 1)).find(
    (j) => j.status === 'pending' && j.attempts === 0 && j.detail
  );
  assert.ok(waiting, 'the job is waiting');
  assert.equal(waiting.nextAt, s.clock.now + 4000, 'for what Fluxer asked');
  assert.equal(waiting.detail, 'Fluxer asked to slow down');
  assert.equal((await db.getPair(s.pair.id)).failures, 0, 'being asked to slow down is not a failure');
  const attemptsBefore = s.fluxer.attempted.length;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.attempted.length, attemptsBefore, 'it does not try again before it is time');
  s.clock.now = waiting.nextAt + 1;
  assert.equal((await drain(s)).status, 'live');
  assert.equal(s.fluxer.ops('createRole').length, 2);
});

test('Fluxer calls are spaced out: a wait after each job that called Fluxer', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: { minIntervalMs: 250 } });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.ok(s.clock.slept.length >= 8, 'every role and channel, and the ordering');
  assert.ok(s.clock.slept.every((ms) => ms === 250));
});

test('a network failure backs off with a doubling delay', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: { pauseAfterFailures: 99 } });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('*', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }), 999);
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    await s.engine.runPair(s.pair.id);
    const job = (await db.listRunJobs(s.pair.id, 1)).find((j) => j.kind === 'guild');
    assert.equal(job.attempts, i + 1);
    waits.push(job.nextAt - job.updatedAt);
    s.clock.now = job.nextAt;
  }
  assert.deepEqual(waits, [100, 200, 400, 800]);
});

test('when Fluxer keeps failing the pair pauses with the reason, and resumes where it stopped', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('*', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }), 999);
  await s.engine.runPair(s.pair.id);
  const pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'paused');
  assert.equal(pair.resumeStatus, 'copying');
  assert.match(pair.lastError, /could not be reached/);
  assert.equal(pair.failures, 3);
  const tries = s.fluxer.attempted.length;
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.attempted.length, tries, 'paused: nothing is tried');
  s.fluxer.clearFailures();
  await s.engine.resume(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).lastError, '');
  assert.equal((await drain(s)).status, 'live');
  assert.equal(s.fluxer.ops('createRole').length, 2);
});

test('a pause because Fluxer could not be reached says when, and goes on by itself once Fluxer answers', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: { unreachableRetryMs: 60_000 } });
  await s.engine.startCopy(s.pair.id);
  const unreachable = () =>
    Object.assign(new Error('fetch failed: connect EHOSTUNREACH 192.0.2.1:443'), { code: 'EHOSTUNREACH' });
  s.fluxer.failOn('*', unreachable(), 999);
  await s.engine.runPair(s.pair.id);
  let pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'paused');
  assert.equal(pair.pauseKind, 'unreachable');
  assert.match(pair.lastError, /could not be reached: fetch failed: connect EHOSTUNREACH/);
  assert.ok(pair.lastErrorAt > 0 && pair.lastErrorAt <= s.clock.now, 'the page can say when it happened');

  // Too soon: no check yet.
  await s.engine.tick();
  await settle();
  assert.equal(s.fluxer.attempted.filter((o) => o === 'ping').length, 0);

  // Still unreachable: it stays paused, with the time of the new attempt.
  s.clock.now += 60_000;
  const checkedAt = s.clock.now;
  await s.engine.tick();
  await settle();
  pair = await db.getPair(s.pair.id);
  assert.equal(s.fluxer.attempted.filter((o) => o === 'ping').length, 1);
  assert.equal(pair.status, 'paused');
  assert.equal(pair.lastErrorAt, checkedAt);

  // The address changed and the name follows: Fluxer answers, and the mirror goes on where it stopped.
  s.fluxer.clearFailures();
  s.clock.now += 60_000;
  await s.engine.tick();
  await settle();
  pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'copying');
  assert.deepEqual([pair.lastError, pair.lastErrorAt, pair.failures, pair.pauseKind], ['', 0, 0, '']);
  assert.equal((await drain(s)).status, 'live');
  assert.equal(s.fluxer.ops('createRole').length, 2);
});

test('the last error of a running mirror clears with the next success', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('*', Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), 1);
  await s.engine.runPair(s.pair.id, { maxJobs: 1 });
  let pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'copying');
  assert.equal(pair.failures, 1);
  assert.ok(pair.lastErrorAt > 0 && pair.lastErrorAt <= s.clock.now);
  s.clock.now += 60_000;
  await s.engine.runPair(s.pair.id, { maxJobs: 1 });
  pair = await db.getPair(s.pair.id);
  assert.deepEqual([pair.failures, pair.lastError, pair.lastErrorAt], [0, '', 0]);
});

test('a pause Sylo cannot end by itself is not checked again', async () => {
  const s = await scenario({ withExpressions: false, engineOpts: { unreachableRetryMs: 1 } });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('createChannel', Object.assign(new Error('Missing Permissions'), { statusCode: 403 }), 99);
  await s.engine.runPair(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).pauseKind, 'failure');
  s.clock.now += 60_000;
  await s.engine.tick();
  await settle();
  assert.equal((await db.getPair(s.pair.id)).status, 'paused', 'a refusal waits for its owner');
  assert.equal(s.fluxer.attempted.filter((o) => o === 'ping').length, 0);
});

test('a job that keeps failing is given up on after the attempts run out', async () => {
  const s = await scenario({ engineOpts: { maxAttempts: 2, pauseAfterFailures: 99 } });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('createEmoji', Object.assign(new Error('bad gateway'), { statusCode: 502 }), 99);
  const end = await drain(s);
  assert.equal(end.status, 'live', 'the copy finishes without those items');
  const failed = await db.listFailedJobs(s.pair.id);
  assert.deepEqual(
    failed.map((j) => [j.kind, j.detail]),
    [
      ['emoji', 'bad gateway'],
      ['emoji', 'bad gateway'],
    ]
  );
  assert.equal(s.fluxer.attempted.filter((o) => o === 'createEmoji').length, 4, 'two attempts each');
});

test('Fluxer refusing Sylo pauses the pair with a reason, and one refused item does not', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.failOn('createChannel', Object.assign(new Error('Missing Permissions'), { statusCode: 403 }), 99);
  await s.engine.runPair(s.pair.id);
  const paused = await db.getPair(s.pair.id);
  assert.equal(paused.status, 'paused');
  assert.match(paused.lastError, /Missing Permissions/);
  assert.match(paused.lastError, /Check Sylo's permissions/);

  const t = await scenario({ withExpressions: false });
  await t.engine.startCopy(t.pair.id);
  t.fluxer.failOn('createChannel', Object.assign(new Error('Invalid Form Body'), { statusCode: 400 }), 1);
  const end = await drain(t);
  assert.equal(end.status, 'live', 'a bad request for one channel is that channel only');
  assert.equal((await db.listFailedJobs(t.pair.id)).length, 1);
  assert.equal((await t.engine.report(end)).failed.length, 1);
});

test('a pair that fails is isolated: the other pair carries on', async () => {
  const a = await scenario({ withExpressions: false });
  const b = await scenario({ withExpressions: false });
  const engine = createEngine({
    now: a.clock.fn,
    sleep: a.clock.sleep,
    minIntervalMs: 1,
    backoffBaseMs: 10,
    clientsReady: () => true,
    sourceGuild: (key) => [a, b].map((x) => x.discord).find((d) => d.id === key),
    targetGuild: (key) => [a, b].map((x) => x.fluxer.guild).find((g) => `fluxer:${g.id}` === key),
    makeTarget: (guild) => [a, b].map((x) => x.fluxer).find((f) => f.guild === guild).target,
    fetchImage: async () => ({ bytes: Buffer.alloc(8), mime: 'image/png' }),
  });
  a.engine = engine;
  b.engine = engine;
  await engine.startCopy(a.pair.id);
  await engine.startCopy(b.pair.id);
  a.fluxer.failOn('createRole', Object.assign(new Error('boom'), { statusCode: 500 }), 99);
  await Promise.all([engine.runPair(a.pair.id), engine.runPair(b.pair.id)]);
  assert.equal((await db.getPair(b.pair.id)).status, 'live', 'B finished');
  assert.equal(b.fluxer.ops('createRole').length, 2);
  assert.notEqual((await db.getPair(a.pair.id)).status, 'live', 'A is still waiting for Fluxer');
  assert.equal(a.fluxer.ops('createRole').length, 0);
  assert.equal(
    b.fluxer.ops('createChannel').length,
    5,
    'and every channel of B went to the Fluxer server of B'
  );
  assert.ok(a.fluxer.guild.channels.size < 5, 'none of them went to A');
});

test('emoji: what does not fit is skipped and reported, in the preview and when Fluxer says it is full', async () => {
  const s = await scenario({ fluxerOpts: { emojiLimit: 1 } });
  const preview = await s.engine.previewPair(s.pair);
  assert.deepEqual(preview.summary.emoji, { create: 1, update: 0, unchanged: 0, skip: 1 });
  assert.ok(preview.notes.some((x) => x.code === 'emoji-limit'));
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.equal(s.fluxer.ops('createEmoji').length, 1);

  // Fluxer's own limit is lower than ours: it refuses, and the rest of that kind is skipped.
  const t = await scenario();
  t.fluxer.failOn(
    'createEmoji',
    Object.assign(new Error('Maximum number of emoji reached (1)'), { statusCode: 400 }),
    99
  );
  await t.engine.startCopy(t.pair.id);
  const end = await drain(t);
  assert.equal(end.status, 'live');
  const report = await t.engine.report(end);
  assert.equal(report.items.filter((i) => i.kind === 'emoji' && i.status === 'skipped').length, 2);
  assert.ok(report.notes.some((x) => x.code === 'emoji-limit'));
  assert.equal((await db.listFailedJobs(t.pair.id)).length, 0, 'being full is not a failure');
  assert.equal(
    t.fluxer.attempted.filter((o) => o === 'createEmoji').length,
    1,
    'it asked once, then stopped asking'
  );
});

test('an emoji over the size limit is skipped with a note', async () => {
  const s = await scenario({ discordOpts: {} });
  s.discord.emojis.cache.get(s.k.emoji1).imageURL = () => 'https://cdn.test/big.png';
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  const report = await s.engine.report(end);
  const note = report.notes.find((x) => x.code === 'emoji-too-large');
  assert.ok(note);
  assert.match(note.message, /512 KB/);
  assert.equal(s.fluxer.ops('createEmoji').length, 1);
});

test('what cannot start is refused with the reason: no permission, a server missing, nobody agreed', async () => {
  const noPerm = await scenario({ fluxerOpts: { missing: ['ManageRoles'] } });
  await assert.rejects(noPerm.engine.startCopy(noPerm.pair.id), /Sylo needs ManageRoles/);
  assert.equal((await noPerm.engine.previewPair(noPerm.pair)).ok, false);
  assert.equal(noPerm.fluxer.calls.length, 0);

  const s = await scenario({ withExpressions: false });
  const lonely = createEngine({
    clientsReady: () => true,
    sourceGuild: () => undefined,
    targetGuild: () => s.fluxer.guild,
  });
  const preview = await lonely.previewPair(s.pair);
  assert.equal(preview.ok, false);
  assert.equal(preview.blockers[0].code, 'source-missing');

  const pending = await db.updatePair(s.pair.id, { targetConsentBy: '', status: 'pending' });
  await assert.rejects(s.engine.startCopy(pending.id), /Fluxer server/);
});

test('a server that disappears pauses the pair once the platforms are up; while one connects it waits', async () => {
  let up = false;
  const s = await scenario({ withExpressions: false, engineOpts: { clientsReady: () => up } });
  await s.engine.startCopy(s.pair.id);
  s.engine.deps.targetGuild = () => undefined;
  await s.engine.runPair(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).status, 'copying', 'waiting for the platform');
  up = true;
  await s.engine.runPair(s.pair.id);
  const pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'paused');
  assert.match(pair.lastError, /no longer in the Fluxer server/);
});

test('losing consent pauses the pair at the next job', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await db.updatePair(s.pair.id, { targetConsentBy: '' });
  await s.engine.runPair(s.pair.id);
  const pair = await db.getPair(s.pair.id);
  assert.equal(pair.status, 'paused');
  assert.equal(s.fluxer.calls.length, 0);
});

test('only one worker runs per pair, and the timer starts workers for pairs that have work', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  const first = s.engine.runPair(s.pair.id);
  const second = await s.engine.runPair(s.pair.id);
  assert.equal(second.ran, 0, 'the second call finds a worker already running');
  await first;
  const t = await scenario({ withExpressions: false });
  await t.engine.startCopy(t.pair.id);
  await t.engine.tick();
  for (let i = 0; i < 100 && t.engine.isRunning(t.pair.id); i += 1) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 100 && (await db.getPair(t.pair.id)).status === 'copying'; i += 1)
    await t.engine.tick();
  assert.equal((await db.getPair(t.pair.id)).status, 'live');
});

test('a second copy after changes sends only what changed', async () => {
  const s = await scenario({ withExpressions: false });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  s.discord.channels.cache.get(s.k.chat).topic = 'a topic';
  s.discord.roles.cache.get(s.k.member).name = 'Members';
  const preview = await s.engine.previewPair(await db.getPair(s.pair.id));
  assert.deepEqual(preview.summary.channel, { create: 0, update: 1, unchanged: 4, skip: 0 });
  assert.deepEqual([preview.summary.role.create, preview.summary.role.update], [0, 1]);
  s.fluxer.calls.length = 0;
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.equal(end.copyRun, 2);
  assert.deepEqual(
    s.fluxer.ops('editChannel').map((c) => c.spec.name),
    ['chat']
  );
  assert.deepEqual(
    s.fluxer.ops('editRole').map((c) => c.spec.name),
    ['Members']
  );
  assert.equal(s.fluxer.ops('createChannel').length, 0);
});
