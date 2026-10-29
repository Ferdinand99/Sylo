// Proves the driver shim's Postgres branch for events + sign-ups: a SERIAL id read back with
// RETURNING, BIGINT times that come back as numbers, the upsert on the composite key, the
// due-reminder arithmetic, the role-elsewhere join, and the erasure statements.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'events against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/events.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-events-${Date.now()}`;
    const H = `${G}-other`;
    const NOW = Date.now();
    const make = (over = {}) =>
      db.createEvent({
        guildId: G,
        channelId: '1',
        title: 'Game night',
        startAt: NOW + 7_200_000,
        hostId: 'h',
        ...over,
      });

    await t.test(
      'createEvent returns an id via RETURNING; the row round-trips with numeric times',
      async () => {
        const { id } = await make({ description: 'd', timeZone: 'Europe/Oslo', capacity: 5, roleId: '700' });
        assert.ok(Number.isInteger(id) && id > 0);
        await db.setEventMessage(id, '333');
        const row = await db.getEvent(id);
        assert.equal(row.message_id, '333');
        assert.equal(typeof row.start_at, 'number');
        assert.equal(row.start_at, NOW + 7_200_000);
        assert.equal(row.end_at, null);
        assert.equal(row.capacity, 5);
        assert.equal(row.time_zone, 'Europe/Oslo');
        assert.equal(row.reminder_sent, false);
        assert.equal(await db.getEventInGuild(id, H), null);
        await db.updateEventRow(id, {
          title: 'New',
          startAt: NOW + 9,
          endAt: NOW + 99,
          timeZone: 'UTC',
          capacity: null,
          reminderMinutes: 15,
          reminderSent: true,
        });
        const edited = await db.getEvent(id);
        assert.equal(edited.title, 'New');
        assert.equal(edited.end_at, NOW + 99);
        assert.equal(edited.capacity, null);
        assert.equal(edited.reminder_sent, true);
        await db.deleteEvent(id);
        assert.equal(await db.getEvent(id), null);
      }
    );

    await t.test(
      'sign-ups: the upsert changes the status without a second row; counts and order',
      async () => {
        const { id } = await make();
        await db.setEventParticipant(id, 'u1', 'join');
        await db.setEventParticipant(id, 'u2', 'maybe');
        await db.setEventParticipant(id, 'u1', 'join');
        await db.setEventParticipant(id, 'u2', 'join'); // ON CONFLICT DO UPDATE
        assert.equal(await db.eventParticipantCount(id), 2);
        assert.equal(await db.eventStatusCount(id, 'join'), 2);
        assert.deepEqual((await db.eventParticipantIds(id, 'join')).sort(), ['u1', 'u2']);
        await db.removeEventParticipant(id, 'u1');
        assert.equal(await db.getEventParticipant(id, 'u1'), null);
        assert.equal((await db.getEventParticipant(id, 'u2')).status, 'join');
      }
    );

    await t.test('states, due endings and due reminders', async () => {
      await db.clearGuildEvents(G);
      const start = NOW + 2 * 3_600_000;
      const r60 = await make({ startAt: start, reminderMinutes: 60 });
      const off = await make({ startAt: start, reminderMinutes: 0 });
      const ids = async (list) => (await list).filter((e) => e.guild_id === G).map((e) => e.id);

      assert.deepEqual(await ids(db.dueReminderEvents(start - 61 * 60_000)), []);
      assert.deepEqual(await ids(db.dueReminderEvents(start - 60 * 60_000)), [r60.id]);
      assert.equal(await db.claimEventReminder(r60.id), true);
      assert.equal(await db.claimEventReminder(r60.id), false);

      assert.deepEqual(await ids(db.dueEndEvents(start + db.END_GRACE_MS - 1)), []);
      assert.deepEqual((await ids(db.dueEndEvents(start + db.END_GRACE_MS))).sort(), [r60.id, off.id].sort());
      assert.equal(await db.claimEventState(r60.id, 'ended'), true);
      assert.equal(await db.claimEventState(r60.id, 'cancelled'), false);
      assert.equal(await db.scheduledEventCount(G), 1);
      assert.deepEqual(
        (await db.upcomingEvents(G)).map((e) => e.id),
        [off.id]
      );
      assert.deepEqual(
        (await db.pastEvents(G, 5)).map((e) => e.id),
        [r60.id]
      );
    });

    await t.test('holdsEventRoleElsewhere joins sign-ups to upcoming events with the same role', async () => {
      await db.clearGuildEvents(G);
      const a = await make({ roleId: '700' });
      const b = await make({ roleId: '700' });
      await db.setEventParticipant(a.id, 'u1', 'join');
      await db.setEventParticipant(b.id, 'u1', 'join');
      await db.setEventParticipant(b.id, 'u3', 'maybe');
      assert.equal(await db.holdsEventRoleElsewhere(G, '700', 'u1', a.id), true);
      assert.equal(await db.holdsEventRoleElsewhere(G, '700', 'u3', a.id), false);
      assert.equal(await db.holdsEventRoleElsewhere(H, '700', 'u1', a.id), false);
      await db.claimEventState(b.id, 'cancelled');
      assert.equal(await db.holdsEventRoleElsewhere(G, '700', 'u1', a.id), false);
    });

    await t.test('forgetUser takes a former host off their events (host_id is nullable)', async () => {
      await db.clearGuildEvents(G);
      const mine = await make({ hostId: 'victim-host' });
      const theirs = await make({ hostId: 'someone-else' });
      assert.equal(
        (await purge.describeUserData(G, 'victim-host')).items.find((i) => i.key === 'eventsHosted').count,
        1
      );
      assert.equal((await purge.forgetUser(G, 'victim-host')).eventsHosted, 1);
      assert.equal((await db.getEvent(mine.id)).host_id, null);
      assert.equal((await db.getEvent(theirs.id)).host_id, 'someone-else');
      await db.clearGuildEvents(G);
    });

    await t.test('forgetUser, describeUserData and purgeGuild cover the sign-ups', async () => {
      await db.clearGuildEvents(G);
      await db.clearGuildEvents(H);
      const a = await make();
      const other = await make({ guildId: H });
      await db.setEventParticipant(a.id, 'victim', 'join');
      await db.setEventParticipant(other.id, 'victim', 'join');

      const seen = await purge.describeUserData(G, 'victim');
      assert.equal(seen.items.find((i) => i.key === 'eventSignups').count, 1);
      assert.equal((await purge.exportUserData(G, 'victim')).data.eventSignups.length, 1);
      assert.equal((await purge.forgetUser(G, 'victim')).eventSignups, 1);
      assert.equal(await db.getEventParticipant(a.id, 'victim'), null);
      assert.ok(await db.getEventParticipant(other.id, 'victim'));

      await db.setEventParticipant(a.id, 'again', 'maybe');
      await purge.purgeGuild(G);
      assert.equal(await db.getEvent(a.id), null);
      assert.equal(await db.eventParticipantCount(a.id), 0);
      assert.ok(await db.getEvent(other.id));
      await purge.purgeGuild(H);
      assert.equal(await db.getEvent(other.id), null);
    });
  }
);
