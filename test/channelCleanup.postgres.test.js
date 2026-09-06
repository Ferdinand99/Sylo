// Proves the driver shim's Postgres branch for real (against the CI matrix's
// service container, or a local Postgres via DATABASE_URL) using the exact
// same src/db/channelCleanup.js module as the SQLite-path test — same
// assertions, same shapes, different driver underneath.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'channelCleanup against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      listCleanupSchedules,
      getCleanupSchedule,
      dueCandidates,
      createCleanupSchedule,
      updateCleanupSchedule,
      deleteCleanupSchedule,
      setCleanupScheduleEnabled,
      markCleanupRan,
    } = await import('../src/db/channelCleanup.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-${Date.now()}`;

    await t.test('create + hydrate: defaults days, stores settings, returns a real id', async () => {
      const id = Number(
        await createCleanupSchedule(G, {
          channelId: '111111111111111111',
          days: [],
          timeHhmm: '03:00',
          maxAgeHours: 24,
          skipPinned: true,
        })
      );
      assert.ok(Number.isInteger(id) && id > 0);
      const s = await getCleanupSchedule(G, id);
      assert.equal(s.channel_id, '111111111111111111');
      assert.equal(s.time_hhmm, '03:00');
      assert.equal(s.max_age_hours, 24);
      assert.equal(s.skip_pinned, 1);
      assert.equal(s.enabled, 1);
      assert.deepEqual(s.dayList, [0, 1, 2, 3, 4, 5, 6]);
    });

    await t.test(
      'list scopes to guild; update rewrites; dueCandidates/markCleanupRan/delete round-trip',
      async () => {
        const other = `pgtest-other-${Date.now()}`;
        await createCleanupSchedule(other, {
          channelId: '1'.repeat(18),
          days: [0],
          timeHhmm: '01:00',
          maxAgeHours: 1,
          skipPinned: true,
        });
        const id = Number(
          await createCleanupSchedule(G, {
            channelId: '1'.repeat(18),
            days: [0, 1, 2, 3, 4, 5, 6],
            timeHhmm: '00:00',
            maxAgeHours: 1,
            skipPinned: true,
          })
        );
        assert.equal((await listCleanupSchedules(other)).length, 1);
        assert.ok((await listCleanupSchedules(G)).some((s) => s.id === id));

        await updateCleanupSchedule(G, id, {
          channelId: '2'.repeat(18),
          days: [6],
          timeHhmm: '06:15',
          maxAgeHours: 48,
          skipPinned: false,
        });
        const updated = await getCleanupSchedule(G, id);
        assert.equal(updated.channel_id, '2'.repeat(18));
        assert.deepEqual(updated.dayList, [6]);
        assert.equal(updated.skip_pinned, 0);

        assert.ok((await dueCandidates('2099-01-01')).some((s) => s.id === id));
        await markCleanupRan(id, '2099-01-01', 3);
        assert.ok(!(await dueCandidates('2099-01-01')).some((s) => s.id === id));

        await setCleanupScheduleEnabled(G, id, false);
        assert.ok(!(await dueCandidates('2099-01-02')).some((s) => s.id === id));

        await deleteCleanupSchedule(G, id);
        assert.equal(await getCleanupSchedule(G, id), null);
      }
    );
  }
);
