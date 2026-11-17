// How the mirror engine uses the bridge step and keeps its links in step, and the two small mirror fixes that came
// with the wiring: a role made again during "copy again" is ordered before it gets its powerful permissions, and a
// change of Fluxer owner turns "Mirror deletions" off until the new owner switches it on.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import { requestMirror } from '../src/mirror/consent.js';
import { BIT, SYLO_ROLE, dChannel } from './helpers/mirrorFakes.js';
import { drain, scenario } from './helpers/mirrorScenario.js';

const ADMIN = 1n << 3n;
const roleBits = (s, id) => BigInt(s.fluxer.guild.roles.get(id)._permissions);

// --- the bridge step ---------------------------------------------------------------------------------------

test('the bridge step is the last step of a copy, and its result shows in the report', async () => {
  const calls = [];
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async (id, opts) => {
        calls.push([id, [...opts.skip]]);
        return {
          linked: 3,
          already: 0,
          remaining: 0,
          tried: [],
          skipped: [
            { sourceId: '11', name: 'adult', code: 'age-restriction', message: 'the ages do not match' },
          ],
        };
      },
    },
  });
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');
  assert.deepEqual(calls, [[s.pair.id, []]]);
  const report = await s.engine.report(await db.getPair(s.pair.id));
  assert.equal(report.bridge.status, 'done');
  assert.equal(report.bridge.detail, '3 channels linked, 1 not linked (see the notes)');
  const note = report.notes.find((n) => n.code === 'bridge-age-restriction');
  assert.deepEqual(note.ref, { kind: 'channel', id: '11', name: 'adult' });
  assert.match(note.message, /adult: not linked through the bridge, the ages do not match/);
});

test('when more channels wait than one run links, another run follows and does not try the same ones again', async () => {
  const calls = [];
  const answers = [
    {
      linked: 2,
      already: 1,
      remaining: 2,
      tried: ['a', 'b', 'c'],
      skipped: [{ sourceId: 'c', name: 'c', code: 'permissions', message: 'Sylo lacks a permission' }],
    },
    { linked: 2, already: 3, remaining: 0, tried: ['d', 'e'], skipped: [] },
  ];
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async (id, opts) => {
        calls.push([...opts.skip]);
        return answers[calls.length - 1];
      },
    },
  });
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live', 'the copy waits for the whole bridge step');
  assert.deepEqual(calls, [[], ['a', 'b', 'c']]);
  const report = await s.engine.report(await db.getPair(s.pair.id));
  assert.equal(report.bridge.status, 'done');
  assert.equal(
    report.bridge.detail,
    '2 channels linked, 1 already linked, 1 not linked (see the notes), 2 more follow; 2 channels linked, 3 already linked'
  );
});

test('a step that links nothing says why', async () => {
  const s = await scenario({
    withExpressions: false,
    engineOpts: { linkMirroredChannels: async () => ({ linked: 0, reason: 'nothing-to-link' }) },
  });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.equal(
    (await s.engine.report(await db.getPair(s.pair.id))).bridge.detail,
    'not linked: nothing-to-link'
  );
});

test('a channel made on Discord later is linked too: the bridge step is asked for again', async () => {
  const calls = [];
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async (id) => {
        calls.push(id);
        return { linked: 1, already: 0, remaining: 0, tried: [], skipped: [] };
      },
    },
  });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.equal(calls.length, 1);
  const newId = '750000000000000077';
  s.discord.channels.cache.set(newId, dChannel({ id: newId, name: 'fresh', type: 0, rawPosition: 9 }));
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: newId });
  await s.engine.runPair(s.pair.id);
  assert.equal(calls.length, 2, 'linked after the channel was made');
  // an edit of an existing channel does not ask again
  s.discord.channels.cache.get(s.k.chat).name = 'chatter';
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'sync', id: s.k.chat });
  await s.engine.runPair(s.pair.id);
  assert.equal(calls.length, 2);
});

// --- links follow the mirror ---------------------------------------------------------------------------------

test('the links of a mirror follow its state: paused, resumed, stopped and released when removed', async () => {
  const states = [];
  const released = [];
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async () => ({ linked: 0, reason: 'nothing-to-link' }),
      syncLinks: async (pair) => {
        states.push(pair.status);
      },
      releaseLinks: async (id) => {
        released.push(id);
      },
    },
  });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  states.length = 0;
  await s.engine.pause(s.pair.id, 'source');
  await s.engine.resume(s.pair.id, { side: 'source' });
  await s.engine.stopPair(s.pair.id);
  assert.deepEqual(states, ['paused', 'live', 'stopped']);
  assert.deepEqual(released, []);
  await s.engine.removePair(s.pair.id);
  assert.deepEqual(released, [s.pair.id], 'released before the pair and its record are gone');
  assert.equal(await db.getPair(s.pair.id), null);
});

test('a pause the mirror makes itself (a failure) pauses the links too', async () => {
  const states = [];
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async () => ({ linked: 0, reason: 'nothing-to-link' }),
      syncLinks: async (pair) => {
        states.push(pair.status);
      },
      enforceOwnership: () => true,
    },
  });
  await s.engine.startCopy(s.pair.id);
  s.fluxer.guild.ownerId = 'new-fluxer-owner';
  await s.engine.runPair(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).pauseKind, 'ownership');
  assert.ok(states.includes('paused'));
});

test('a link that cannot be put right does not break the mirror; the timer tries again', async () => {
  let fail = true;
  let sweeps = 0;
  const s = await scenario({
    withExpressions: false,
    engineOpts: {
      linkMirroredChannels: async () => ({ linked: 0, reason: 'nothing-to-link' }),
      syncLinks: async () => {
        sweeps += 1;
        if (fail) throw new Error('database is busy');
      },
    },
  });
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const paused = await s.engine.pause(s.pair.id, 'source');
  assert.equal(paused.status, 'paused', 'the pause itself went through');
  const before = sweeps;
  fail = false;
  s.clock.now += 120_000;
  await s.engine.tick();
  assert.ok(sweeps > before, 'the sweep of the timer ran again');
});

// --- minor: a role made again in "copy again" ------------------------------------------------------------------

test('a role deleted on Fluxer and made again by "copy again" is ordered, then gets its powerful permissions', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator | BIT.ViewChannel };
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  const first = (await db.getMapping(s.pair.id, 'role', s.k.mod)).targetId;
  assert.equal(roleBits(s, first) & ADMIN, ADMIN, 'the first copy granted it');

  // Somebody deletes the role on Fluxer, and the role changes on Discord (so the copy sends it again), but the order
  // of the roles does not change, so the plan has no order step.
  s.fluxer.guild.roles.delete(first);
  s.discord.roles.cache.get(s.k.mod).name = 'Moderators';
  const preview = await s.engine.previewPair(await db.getPair(s.pair.id));
  assert.equal(preview.steps.find((x) => x.key === 'order-roles:roles').op, 'unchanged');
  s.fluxer.calls.length = 0;
  await s.engine.startCopy(s.pair.id);
  assert.equal((await drain(s)).status, 'live');

  const again = (await db.getMapping(s.pair.id, 'role', s.k.mod)).targetId;
  assert.notEqual(again, first, 'a new role was made');
  const calls = s.fluxer.calls;
  const made = calls.findIndex((c) => c.op === 'createRole');
  const ordered = calls.findIndex((c) => c.op === 'setRolePositions');
  const granted = calls.findIndex((c) => c.op === 'editRole' && c.id === again);
  assert.ok(made >= 0 && made < ordered && ordered < granted, 'made, then ordered, then granted');
  assert.equal(BigInt(calls[made].spec.permissions) & ADMIN, 0n, 'made without Administrator');
  assert.equal(roleBits(s, again) & ADMIN, ADMIN, 'and granted at the end');
  assert.ok((await db.getMapping(s.pair.id, 'role', s.k.mod)).specHash, 'and the fingerprint is final');
  assert.ok(s.fluxer.guild.roles.get(SYLO_ROLE).position > s.fluxer.guild.roles.get(again).position);
});

test('a first copy still sets the role order once for all its roles', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  await s.engine.startCopy(s.pair.id);
  await drain(s);
  assert.equal(s.fluxer.ops('setRolePositions').length, 1);
  assert.equal(roleBits(s, (await db.getMapping(s.pair.id, 'role', s.k.mod)).targetId) & ADMIN, ADMIN);
});

// --- minor: a new Fluxer owner starts with "Mirror deletions" off ------------------------------------------------

test('a change of Fluxer owner turns "Mirror deletions" off until the new owner switches it on', async () => {
  const s = await scenario({
    withExpressions: false,
    options: { mirrorDeletes: true },
    engineOpts: { enforceOwnership: () => true },
  });
  assert.deepEqual(
    [s.pair.options.mirrorDeletes, s.pair.options.mirrorDeletesRequested],
    [true, true],
    'the owner of both servers had it on'
  );
  await s.engine.startCopy(s.pair.id);
  await s.engine.runPair(s.pair.id, { maxJobs: 2 });
  s.fluxer.guild.ownerId = 'new-fluxer-owner';
  await s.engine.runPair(s.pair.id);
  assert.equal((await db.getPair(s.pair.id)).pauseKind, 'ownership');
  assert.equal((await db.getPair(s.pair.id)).options.mirrorDeletes, true, 'still on until somebody confirms');

  // The Discord owner confirming does not change who the Fluxer owner is.
  await s.engine.resume(s.pair.id, { side: 'source' });
  assert.equal((await db.getPair(s.pair.id)).options.mirrorDeletes, true);

  const pair = await s.engine.resume(s.pair.id, { side: 'target' });
  assert.equal(pair.status, 'copying');
  assert.equal(pair.targetConsentUser, 'new-fluxer-owner');
  assert.deepEqual(
    [pair.options.mirrorDeletes, pair.options.mirrorDeletesRequested],
    [false, true],
    'off for the new owner, with the request still there for them to answer'
  );
  await drain(s);
  // A delete on Discord now only locks the Fluxer copy.
  s.discord.channels.cache.delete(s.k.chat);
  await s.engine.noteSourceChange(s.k.src, { kind: 'channel', op: 'delete', id: s.k.chat });
  await s.engine.runPair(s.pair.id);
  assert.equal(s.fluxer.ops('deleteChannel').length, 0, 'nothing is deleted on Fluxer');
  assert.ok((await db.getMapping(s.pair.id, 'channel', s.k.chat)).removedAt > 0);
});

test('a new request keeps real deletion only for the same Fluxer owner who owns both servers', async () => {
  const D1 = '921000000000000001';
  const F1 = 'fluxer:821000000000000001';
  const ask = (over) =>
    requestMirror({
      sourceGuild: D1,
      targetGuild: F1,
      actor: 'Anna',
      sourceUser: 'dc-owner',
      targetUser: 'fx-owner',
      targetOwner: true,
      ...over,
    });
  const first = await ask({ options: { mirrorDeletes: true } });
  assert.equal(first.pair.options.mirrorDeletes, true);

  const same = await ask({});
  assert.deepEqual(
    [same.pair.options.mirrorDeletes, same.pair.options.mirrorDeletesRequested],
    [true, true],
    'the same owner of both servers asking again keeps it'
  );
  const newOwner = await ask({ targetUser: 'fx-new-owner' });
  assert.deepEqual(
    [newOwner.pair.options.mirrorDeletes, newOwner.pair.options.mirrorDeletesRequested],
    [false, true],
    'a new Fluxer owner starts with it off'
  );
  await ask({ targetUser: 'fx-owner', options: { mirrorDeletes: true } });
  const stranger = await ask({ targetOwner: false });
  assert.deepEqual(
    [stranger.pair.options.mirrorDeletes, stranger.pair.options.mirrorDeletesRequested],
    [false, true],
    'a request from someone who is not the Fluxer owner never carries it'
  );
  // The request brings its own options: the existing rules for them apply (asked, not on).
  const explicit = await ask({ targetOwner: false, options: { mirrorDeletes: true } });
  assert.deepEqual(
    [explicit.pair.options.mirrorDeletes, explicit.pair.options.mirrorDeletesRequested],
    [false, true]
  );
  await db.deletePair(explicit.pair.id);
});
