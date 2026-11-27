// The mirror's tables (src/db/mirror.js): pairs that are unique per server, the id map, and the queue that
// makes a copy resumable. The same file runs against Postgres in mirror.postgres.test.js.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import { MIGRATIONS, db as sqlite } from '../src/db/index.js';
import { purgeGuild } from '../src/db/purge.js';

const A = '910000000000000001';
const B = 'fluxer:810000000000000001';
const C = '910000000000000002';
const D = 'fluxer:810000000000000002';

test('a pair round-trips, and a server can be in only one pair', async () => {
  const pair = await db.createPair({
    sourceGuild: A,
    targetGuild: B,
    options: { roles: false },
    requestedBy: 'x',
    now: 1000,
  });
  assert.equal(pair.status, 'pending');
  assert.deepEqual(pair.options, { roles: false });
  assert.equal(typeof pair.createdAt, 'number');
  await assert.rejects(db.createPair({ sourceGuild: A, targetGuild: D }), 'the source is taken');
  await assert.rejects(db.createPair({ sourceGuild: C, targetGuild: B }), 'the target is taken');
  assert.equal((await db.getPairBySource(A)).id, pair.id);
  assert.equal((await db.getPairByTarget(B)).id, pair.id);
  assert.equal((await db.pairsOfGuild(B)).length, 1);
  assert.equal(await db.getPairBySource(C), null);

  const changed = await db.updatePair(pair.id, { status: 'ready', copyRun: 2, options: { name: false } });
  assert.equal(changed.status, 'ready');
  assert.equal(changed.copyRun, 2);
  assert.deepEqual(changed.options, { name: false });
  assert.deepEqual(
    (await db.listPairsIn('ready')).map((p) => p.id),
    [pair.id]
  );
});

test('the id map keeps what Sylo made and whether it owns it', async () => {
  const pair = await db.getPairBySource(A);
  await db.putMapping({
    pairId: pair.id,
    kind: 'channel',
    sourceId: '1',
    targetId: 't1',
    owned: true,
    specHash: 'h1',
  });
  await db.putMapping({ pairId: pair.id, kind: 'role', sourceId: '2', targetId: 't2', owned: false });
  let m = await db.getMapping(pair.id, 'channel', '1');
  assert.deepEqual([m.targetId, m.owned, m.specHash], ['t1', true, 'h1']);
  assert.equal((await db.getMappingByTarget(pair.id, 'channel', 't1')).sourceId, '1');
  assert.equal((await db.getMapping(pair.id, 'role', '2')).owned, false);
  await db.putMapping({
    pairId: pair.id,
    kind: 'channel',
    sourceId: '1',
    targetId: 't1',
    owned: true,
    specHash: 'h2',
  });
  m = await db.getMapping(pair.id, 'channel', '1');
  assert.equal(m.specHash, 'h2', 'a second put replaces the first');
  assert.equal((await db.listMappings(pair.id, 'channel')).length, 1);
  await db.deleteMapping(pair.id, 'channel', '1');
  assert.equal(await db.getMapping(pair.id, 'channel', '1'), null);
});

test('jobs: coalesce while waiting, claim once, retry, recover and count', async () => {
  const pair = await db.getPairBySource(A);
  const add = (extra = {}) =>
    db.enqueueJob({
      pairId: pair.id,
      phase: 'sync',
      op: 'sync',
      kind: 'channel',
      sourceId: '9',
      stepKey: 'sync:channel:9',
      now: 5000,
      ...extra,
    });
  assert.equal(await add(), true);
  assert.equal(await add(), false, 'the same item is already waiting');
  const first = await db.nextDueJob(pair.id, 5000);
  assert.equal(first.stepKey, 'sync:channel:9');
  assert.equal(await db.claimJob(first.id, 5000), true);
  assert.equal(await db.claimJob(first.id, 5000), false, 'taken once');
  assert.equal(await add(), true, 'a change while the job runs is a new job');
  assert.equal(await db.openSyncCount(pair.id), 2);

  // A restart: the running job waits again, but the newer one for the same step wins, so it is dropped.
  await db.recoverRunningJobs(6000);
  const dropped = await db.getJob(first.id);
  assert.equal(dropped.status, 'skipped');
  assert.equal(await db.openSyncCount(pair.id), 1);
  const second = await db.nextDueJob(pair.id, 6000);
  assert.equal(await db.claimJob(second.id, 6000), true);
  await db.recoverRunningJobs(6500);
  const recovered = await db.getJob(second.id);
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.recovering, true);

  await db.retryJob(second.id, 2, 9000, 'later');
  assert.equal(await db.nextDueJob(pair.id, 8000), null, 'a retried job waits until it is due');
  assert.equal(await db.nextDueAt(pair.id), 9000);
  assert.equal((await db.nextDueJob(pair.id, 9000)).id, second.id);

  await db.finishJob(second.id, 'failed', 'boom', [{ code: 'x' }], 7000);
  const done = await db.getJob(second.id);
  assert.deepEqual(
    [done.status, done.detail, done.notes.length, done.recovering],
    ['failed', 'boom', 1, false]
  );
  assert.equal((await db.listFailedJobs(pair.id)).length, 1);

  await db.enqueueJob({
    pairId: pair.id,
    run: 1,
    phase: 'copy',
    op: 'sync',
    kind: 'role',
    sourceId: '3',
    stepKey: 'copy:1:role:3',
    now: 1,
  });
  await db.enqueueJob({
    pairId: pair.id,
    run: 1,
    phase: 'copy',
    op: 'sync',
    kind: 'role',
    sourceId: '4',
    stepKey: 'copy:1:role:4',
    now: 1,
  });
  const j = await db.nextDueJob(pair.id, 10_000);
  await db.finishJob(j.id, 'done');
  const counts = await db.jobCounts(pair.id, 1);
  assert.equal(counts.pending + counts.done, 2);
  assert.equal(typeof counts.done, 'number');
  assert.equal(await db.openCopyCount(pair.id, 1), 1);

  await db.dropOpenJobs(pair.id, 'stopped');
  assert.equal(await db.openCopyCount(pair.id, 1), 0);
  assert.equal(await db.openSyncCount(pair.id), 0);
});

test('purging a server removes every pair it is in, with the map and the queue', async () => {
  const other = await db.createPair({ sourceGuild: C, targetGuild: D });
  await db.putMapping({ pairId: other.id, kind: 'role', sourceId: '1', targetId: 't' });
  await db.enqueueJob({
    pairId: other.id,
    phase: 'sync',
    op: 'sync',
    kind: 'role',
    sourceId: '1',
    stepKey: 'k',
  });
  const mine = await db.getPairBySource(A);
  await purgeGuild(B); // the Fluxer side of the first pair
  assert.equal(await db.getPair(mine.id), null);
  assert.equal((await db.listMappings(mine.id, 'channel')).length, 0);
  assert.ok(await db.getPair(other.id), 'the other pair is untouched');
  assert.equal((await db.listMappings(other.id, 'role')).length, 1);
  await purgeGuild(C);
  assert.equal(await db.getPair(other.id), null);
  assert.equal(await db.openSyncCount(other.id), 0);
});

test('the id map notes what was removed on Discord, and what a pair has made', async () => {
  const pair = await db.createPair({
    sourceGuild: '910000000000000010',
    targetGuild: 'fluxer:810000000000000010',
  });
  await db.putMapping({ pairId: pair.id, kind: 'channel', sourceId: '1', targetId: 't1', label: 'general' });
  await db.putMapping({ pairId: pair.id, kind: 'role', sourceId: '2', targetId: 't2', label: 'Mod' });
  assert.equal((await db.getMapping(pair.id, 'channel', '1')).label, 'general');
  assert.equal(await db.countMappings(pair.id), 2);
  assert.deepEqual(await db.listRemoved(pair.id), []);
  await db.markRemoved(pair.id, 'channel', '1', 5000);
  const removed = await db.listRemoved(pair.id);
  assert.deepEqual(
    removed.map((m) => [m.kind, m.label, m.removedAt]),
    [['channel', 'general', 5000]]
  );
  // Syncing the same item again clears the mark.
  await db.putMapping({ pairId: pair.id, kind: 'channel', sourceId: '1', targetId: 't1', label: 'general' });
  assert.deepEqual(await db.listRemoved(pair.id), []);
  await db.deletePair(pair.id);
});

test('the burst brake counts the delete jobs a pair queued in a window', async () => {
  const pair = await db.createPair({
    sourceGuild: '910000000000000011',
    targetGuild: 'fluxer:810000000000000011',
  });
  const queue = (op, id, now) =>
    db.enqueueJob({
      pairId: pair.id,
      phase: 'sync',
      op,
      kind: 'channel',
      sourceId: id,
      stepKey: `${op}:${id}`,
      now,
    });
  await queue('delete', 'a', 1000);
  await queue('delete', 'b', 2000);
  await queue('sync', 'c', 2000);
  await queue('delete', 'a', 3000); // the same item again while waiting: still one job
  assert.equal(await db.countRecentDeletes(pair.id, 0), 2);
  assert.equal(await db.countRecentDeletes(pair.id, 1500), 1);
  await db.deletePair(pair.id);
});

test('a job remembers when it was first taken, and a retry after a timeout is marked as maybe done', async () => {
  const pair = await db.createPair({
    sourceGuild: '910000000000000012',
    targetGuild: 'fluxer:810000000000000012',
  });
  await db.enqueueJob({
    pairId: pair.id,
    phase: 'sync',
    op: 'sync',
    kind: 'role',
    sourceId: '1',
    stepKey: 'k',
    now: 100,
  });
  const job = await db.nextDueJob(pair.id, 100);
  assert.equal(job.firstClaimAt, 0);
  await db.claimJob(job.id, 500);
  await db.retryJob(job.id, 1, 600, 'timed out', 550, { maybeDone: true });
  await db.claimJob(job.id, 700);
  const again = await db.getJob(job.id);
  assert.deepEqual([again.firstClaimAt, again.recovering], [500, true], 'the first claim time is kept');
  await db.deletePair(pair.id);
});

test('the SQLite migration can run twice without failing (IF NOT EXISTS)', () => {
  const step = MIGRATIONS[MIGRATIONS.length - 1];
  assert.doesNotThrow(() => step(sqlite));
  assert.doesNotThrow(() => step(sqlite));
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mirror_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['mirror_ids', 'mirror_jobs', 'mirror_links', 'mirror_pairs']);
});

test('the bridge links of a pair: one per Discord channel, found again by link, gone with the pair', async () => {
  const pair = await db.createPair({ sourceGuild: C, targetGuild: D, now: 1000 });
  await db.putMirrorLink(pair.id, 'c1', 't1', 11, 2000);
  await db.putMirrorLink(pair.id, 'c2', 't2', 12, 2100);
  await db.putMirrorLink(pair.id, 'c1', 'other', 99, 2200); // the first record of a channel stays
  const links = await db.listMirrorLinks(pair.id);
  assert.deepEqual(
    links.map((l) => [l.sourceChannel, l.targetChannel, l.linkId, l.createdAt]),
    [
      ['c1', 't1', 11, 2000],
      ['c2', 't2', 12, 2100],
    ]
  );
  assert.equal((await db.getMirrorLink(pair.id, 'c2')).linkId, 12);
  assert.equal(await db.getMirrorLink(pair.id, 'nope'), null);
  assert.equal(await db.mirrorPairOfLink(12), pair.id);
  assert.equal(await db.mirrorPairOfLink(404), null, 'a link made by hand belongs to no mirror');
  await db.deletePair(pair.id);
  assert.deepEqual(await db.listMirrorLinks(pair.id), []);
  assert.equal(await db.mirrorPairOfLink(12), null);
});
