// Proves the driver shim's Postgres branch for scheduled_messages (reminders):
// a SERIAL surrogate PK read back via RETURNING id (returningId: true), and
// the millisecond-timestamp columns (next_run_at, run_at, start_at, end_at,
// last_run_at, created_at) stored as BIGINT. Same assertions as a slice of
// reminders.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'reminders (scheduled_messages) against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      createReminder,
      updateReminder,
      getScheduled,
      listScheduled,
      dueScheduled,
      advanceReminder,
      markSingleFired,
      setScheduledEnabled,
    } = await import('../src/db/scheduledMessages.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-reminders-${Date.now()}`;

    await t.test('createReminder returns a real id via RETURNING id; hydrate round-trips', async () => {
      const id = await createReminder(G, {
        name: 'Standup',
        channelId: '111111111111111111',
        spec: { content: 'stand up', embeds: [] },
        mode: 'multiple',
        intervalMinutes: 60,
        days: [1, 2, 3, 4, 5],
      });
      assert.ok(Number.isInteger(Number(id)) && Number(id) > 0);
      const r = await getScheduled(G, Number(id));
      assert.equal(r.name, 'Standup');
      assert.deepEqual(r.dayList, [1, 2, 3, 4, 5]);
      assert.ok(r.next_run_at > Date.now());
    });

    await t.test('single-mode run_at survives as a BIGINT ms timestamp', async () => {
      const when = Date.now() + 3_600_000;
      const id = await createReminder(G, {
        name: 'One-off',
        channelId: '111111111111111111',
        spec: { content: 'once', embeds: [] },
        mode: 'single',
        intervalMinutes: 60,
        runAt: when,
      });
      const r = await getScheduled(G, Number(id));
      assert.equal(Number(r.run_at), when);
    });

    await t.test(
      'dueScheduled, advanceReminder, markSingleFired, updateReminder, listScheduled',
      async () => {
        const past = Date.now() - 1000;
        const a = await createReminder(G, {
          name: 'A',
          channelId: '1'.repeat(18),
          spec: { content: 'a', embeds: [] },
          mode: 'single',
          intervalMinutes: 60,
          runAt: past,
        });
        const due = (await dueScheduled(Date.now())).map((r) => Number(r.id));
        assert.ok(due.includes(Number(a)));

        await advanceReminder(Number(a), 30, Date.now());
        await markSingleFired(Number(a), Date.now());
        assert.equal((await getScheduled(G, Number(a))).enabled, 0);

        await updateReminder(G, Number(a), {
          name: 'A2',
          channelId: '2'.repeat(18),
          spec: { content: 'a2', embeds: [] },
          mode: 'multiple',
          intervalMinutes: 120,
          days: [6],
        });
        const r = await getScheduled(G, Number(a));
        assert.equal(r.name, 'A2');
        assert.deepEqual(r.dayList, [6]);

        await setScheduledEnabled(G, Number(a), false);
        assert.equal((await getScheduled(G, Number(a))).enabled, 0);
        assert.ok((await listScheduled(G)).length >= 1);
      }
    );
  }
);
