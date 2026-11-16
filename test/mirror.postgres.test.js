// The mirror's tables against a real Postgres connection: serial ids, BIGINT times that come back as numbers,
// the partial unique index that coalesces waiting jobs, ON CONFLICT upserts and the purge.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'server mirror tables against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/mirror.js');
    const { purgeGuild } = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });
    const n = Date.now();
    const A = `9${String(n).padStart(17, '0')}`.slice(0, 18);
    const B = `fluxer:8${String(n).padStart(17, '0')}`.slice(0, 26);
    const C = `9${String(n + 1).padStart(17, '0')}`.slice(0, 18);

    await t.test('pairs are unique per server and times are numbers', async () => {
      const pair = await db.createPair({
        sourceGuild: A,
        targetGuild: B,
        options: { roles: false },
        now: 1_800_000_000_000,
      });
      assert.equal(typeof pair.id, 'number');
      assert.equal(pair.createdAt, 1_800_000_000_000);
      assert.equal(typeof pair.createdAt, 'number');
      await assert.rejects(db.createPair({ sourceGuild: A, targetGuild: `${B}9` }));
      const next = await db.updatePair(pair.id, { status: 'ready', copyRun: 3, options: { name: false } });
      assert.deepEqual([next.status, next.copyRun, next.options.name], ['ready', 3, false]);
      assert.equal((await db.pairsOfGuild(B)).length, 1);
    });

    await t.test('the id map upserts and deletes', async () => {
      const pair = await db.getPairBySource(A);
      await db.putMapping({
        pairId: pair.id,
        kind: 'channel',
        sourceId: '1',
        targetId: 't1',
        owned: true,
        specHash: 'a',
      });
      await db.putMapping({
        pairId: pair.id,
        kind: 'channel',
        sourceId: '1',
        targetId: 't1',
        owned: false,
        specHash: 'b',
      });
      const m = await db.getMapping(pair.id, 'channel', '1');
      assert.deepEqual([m.owned, m.specHash], [false, 'b']);
      assert.equal((await db.getMappingByTarget(pair.id, 'channel', 't1')).sourceId, '1');
      await db.deleteMapping(pair.id, 'channel', '1');
      assert.equal(await db.getMapping(pair.id, 'channel', '1'), null);
    });

    await t.test('waiting jobs coalesce, claim once, requeue and count', async () => {
      const pair = await db.getPairBySource(A);
      const add = () =>
        db.enqueueJob({
          pairId: pair.id,
          phase: 'sync',
          op: 'sync',
          kind: 'role',
          sourceId: '5',
          stepKey: 'sync:role:5',
          now: 5000,
        });
      assert.equal(await add(), true);
      assert.equal(await add(), false);
      const job = await db.nextDueJob(pair.id, 5000);
      assert.equal(typeof job.nextAt, 'number');
      assert.equal(await db.claimJob(job.id), true);
      assert.equal(await db.claimJob(job.id), false);
      assert.equal(await add(), true, 'a new change while it runs');
      await db.recoverRunningJobs();
      assert.equal(
        (await db.getJob(job.id)).status,
        'skipped',
        'the newer waiting job replaces the recovered one'
      );
      const waiting = await db.nextDueJob(pair.id, 5000);
      await db.retryJob(waiting.id, 1, 9000, 'later');
      assert.equal(await db.nextDueAt(pair.id), 9000);
      assert.equal(typeof (await db.nextDueAt(pair.id)), 'number');
      assert.equal(await db.nextDueJob(pair.id, 8000), null);
      await db.finishJob(waiting.id, 'failed', 'boom', [{ code: 'x' }]);
      assert.equal((await db.listFailedJobs(pair.id))[0].notes.length, 1);
      assert.equal(typeof (await db.jobCounts(pair.id, 0, 'sync')).failed, 'number');
      assert.equal(await db.openSyncCount(pair.id), 0);
    });

    await t.test('purging a server removes its pair, map and queue', async () => {
      const pair = await db.getPairBySource(A);
      await db.putMapping({ pairId: pair.id, kind: 'role', sourceId: '2', targetId: 't2' });
      const other = await db.createPair({ sourceGuild: C, targetGuild: `${B}7` });
      await purgeGuild(A);
      assert.equal(await db.getPair(pair.id), null);
      assert.equal((await db.listMappings(pair.id, 'role')).length, 0);
      assert.ok(await db.getPair(other.id));
      await purgeGuild(C);
    });
  }
);
