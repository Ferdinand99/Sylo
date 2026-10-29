// Events storage on SQLite, and the per-member / per-server erasure that covers it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END_GRACE_MS,
  claimEventReminder,
  claimEventState,
  clearGuildEvents,
  createEvent,
  deleteEvent,
  dueEndEvents,
  dueReminderEvents,
  eventParticipantCount,
  eventParticipantIds,
  eventStatusCount,
  getEvent,
  getEventInGuild,
  getEventParticipant,
  holdsEventRoleElsewhere,
  pastEvents,
  removeEventParticipant,
  scheduledEventCount,
  setEventMessage,
  setEventParticipant,
  updateEventRow,
  upcomingEvents,
} from '../src/db/events.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';

const G = '900000000000000321';
const H = '900000000000000322';
const NOW = 1_800_000_000_000;
const ev = (over = {}) => ({
  guildId: G,
  channelId: '100000000000000001',
  title: 'Game night',
  startAt: NOW + 3_600_000,
  hostId: '222',
  ...over,
});

test('an event round-trips, with numbers as numbers and optional fields empty', async () => {
  const { id } = await createEvent(ev({ description: 'd', location: 'l', timeZone: 'Europe/Oslo' }));
  assert.ok(id > 0);
  await setEventMessage(id, '333');
  const row = await getEvent(id);
  assert.equal(row.title, 'Game night');
  assert.equal(row.message_id, '333');
  assert.equal(row.start_at, NOW + 3_600_000);
  assert.equal(typeof row.start_at, 'number');
  assert.equal(row.end_at, null);
  assert.equal(row.capacity, null);
  assert.equal(row.role_id, null);
  assert.equal(row.time_zone, 'Europe/Oslo');
  assert.equal(row.state, 'scheduled');
  assert.equal(row.reminder_sent, false);
  assert.equal((await getEventInGuild(id, G)).id, id);
  assert.equal(await getEventInGuild(id, H), null, 'another server does not see it');
  assert.equal(await getEvent(987654), null);
});

test('sign-ups: one row per member, Join <-> Maybe changes it, leaving deletes', async () => {
  const { id } = await createEvent(ev());
  await setEventParticipant(id, 'u1', 'join');
  await setEventParticipant(id, 'u2', 'maybe');
  await setEventParticipant(id, 'u3', 'join');
  await setEventParticipant(id, 'u1', 'join'); // again: still one row
  assert.equal(await eventParticipantCount(id), 3);
  assert.equal(await eventStatusCount(id, 'join'), 2);
  assert.equal(await eventStatusCount(id, 'maybe'), 1);
  assert.deepEqual(await getEventParticipant(id, 'u2'), { userId: 'u2', status: 'maybe' });
  await setEventParticipant(id, 'u2', 'join'); // upsert
  assert.equal((await getEventParticipant(id, 'u2')).status, 'join');
  assert.equal(await eventStatusCount(id, 'maybe'), 0);
  assert.deepEqual((await eventParticipantIds(id, 'join')).sort(), ['u1', 'u2', 'u3']);
  await removeEventParticipant(id, 'u2');
  assert.equal(await getEventParticipant(id, 'u2'), null);
  assert.equal(await eventParticipantCount(id), 2);
  await deleteEvent(id);
  assert.equal(await getEvent(id), null);
  assert.equal(await eventParticipantCount(id), 0, 'its sign-ups go with it');
});

test('upcoming, past and the per-server count follow the state', async () => {
  await clearGuildEvents(G);
  const a = await createEvent(ev({ startAt: NOW + 2000 }));
  const b = await createEvent(ev({ startAt: NOW + 1000 }));
  const c = await createEvent(ev({ startAt: NOW + 3000 }));
  assert.deepEqual(
    (await upcomingEvents(G)).map((e) => e.id),
    [b.id, a.id, c.id],
    'soonest first'
  );
  assert.equal(await scheduledEventCount(G), 3);
  assert.equal(await claimEventState(a.id, 'cancelled'), true);
  assert.equal(await claimEventState(a.id, 'ended'), false, 'only the first claim wins');
  assert.equal(await claimEventState(c.id, 'ended'), true);
  assert.equal(await scheduledEventCount(G), 1);
  assert.deepEqual(
    (await pastEvents(G, 10)).map((e) => e.id),
    [c.id, a.id],
    'latest first'
  );
  assert.equal((await pastEvents(G, 1)).length, 1);
  assert.equal((await getEvent(a.id)).state, 'cancelled');
  assert.equal(await scheduledEventCount(H), 0);
});

test('due endings: the end time, or two hours after the start when there is none', async () => {
  await clearGuildEvents(G);
  const noEnd = await createEvent(ev({ startAt: NOW }));
  const withEnd = await createEvent(ev({ startAt: NOW, endAt: NOW + 5 * 3_600_000 }));
  const ids = async (t) => (await dueEndEvents(t)).filter((e) => e.guild_id === G).map((e) => e.id);
  assert.deepEqual(await ids(NOW + END_GRACE_MS - 1), []);
  assert.deepEqual(await ids(NOW + END_GRACE_MS), [noEnd.id]);
  assert.deepEqual((await ids(NOW + 5 * 3_600_000)).sort(), [noEnd.id, withEnd.id].sort());
  await claimEventState(noEnd.id, 'ended');
  assert.deepEqual(await ids(NOW + 5 * 3_600_000), [withEnd.id]);
});

test('due reminders: inside the window, off events never, and the claim is taken once', async () => {
  await clearGuildEvents(G);
  const start = NOW + 2 * 3_600_000;
  const r60 = await createEvent(ev({ startAt: start, reminderMinutes: 60 }));
  const off = await createEvent(ev({ startAt: start, reminderMinutes: 0 }));
  const done = await createEvent(ev({ startAt: start, reminderMinutes: 60, reminderSent: true }));
  const ids = async (t) => (await dueReminderEvents(t)).filter((e) => e.guild_id === G).map((e) => e.id);
  assert.deepEqual(await ids(start - 61 * 60_000), []);
  assert.deepEqual(await ids(start - 60 * 60_000), [r60.id]);
  assert.deepEqual(await ids(start + 1_000_000), [r60.id], 'still listed until claimed');
  assert.equal(await claimEventReminder(r60.id), true);
  assert.equal(await claimEventReminder(r60.id), false);
  assert.deepEqual(await ids(start), []);
  assert.ok(off.id && done.id);
});

test('updateEventRow saves the editable fields only', async () => {
  const { id } = await createEvent(ev({ roleId: '700', capacity: 3 }));
  await setEventMessage(id, '333');
  await updateEventRow(id, {
    title: 'New',
    description: 'd2',
    location: 'l2',
    imageUrl: 'https://example.com/i.png',
    startAt: NOW + 9,
    endAt: NOW + 99,
    timeZone: 'Asia/Tokyo',
    capacity: null,
    reminderMinutes: 15,
    reminderSent: true,
  });
  const row = await getEvent(id);
  assert.equal(row.title, 'New');
  assert.equal(row.image_url, 'https://example.com/i.png');
  assert.equal(row.start_at, NOW + 9);
  assert.equal(row.end_at, NOW + 99);
  assert.equal(row.time_zone, 'Asia/Tokyo');
  assert.equal(row.capacity, null);
  assert.equal(row.reminder_minutes, 15);
  assert.equal(row.reminder_sent, true);
  assert.equal(row.role_id, '700', 'the role stays');
  assert.equal(row.message_id, '333', 'and so does the posted message');
});

test('holdsEventRoleElsewhere: only upcoming events of the same server and role count', async () => {
  await clearGuildEvents(G);
  const a = await createEvent(ev({ roleId: '700' }));
  const b = await createEvent(ev({ roleId: '700' }));
  const other = await createEvent(ev({ roleId: '701' }));
  await setEventParticipant(a.id, 'u1', 'join');
  await setEventParticipant(b.id, 'u1', 'join');
  await setEventParticipant(other.id, 'u2', 'join');
  await setEventParticipant(b.id, 'u3', 'maybe');
  assert.equal(await holdsEventRoleElsewhere(G, '700', 'u1', a.id), true);
  assert.equal(await holdsEventRoleElsewhere(G, '700', 'u2', a.id), false, 'a different role');
  assert.equal(await holdsEventRoleElsewhere(G, '700', 'u3', a.id), false, 'Maybe does not hold the role');
  assert.equal(await holdsEventRoleElsewhere(H, '700', 'u1', a.id), false, 'a different server');
  await claimEventState(b.id, 'ended');
  assert.equal(await holdsEventRoleElsewhere(G, '700', 'u1', a.id), false, 'the other event is over');
});

test('forgetUser removes a member sign-ups in that server only; describeUserData and /mydata list them', async () => {
  await clearGuildEvents(G);
  await clearGuildEvents(H);
  const a = await createEvent(ev());
  const past = await createEvent(ev());
  await claimEventState(past.id, 'ended');
  const elsewhere = await createEvent(ev({ guildId: H }));
  for (const id of [a.id, past.id, elsewhere.id]) await setEventParticipant(id, 'victim', 'join');
  await setEventParticipant(a.id, 'bystander', 'maybe');

  const seen = await describeUserData(G, 'victim');
  const item = seen.items.find((i) => i.key === 'eventSignups');
  assert.equal(item.count, 2);
  assert.equal(item.kept, false);
  assert.equal(seen.erasable >= 2, true);
  const exported = await exportUserData(G, 'victim');
  assert.equal(exported.data.eventSignups.length, 2);
  assert.equal(exported.data.eventSignups[0].user_id, 'victim');

  const result = await forgetUser(G, 'victim');
  assert.equal(result.eventSignups, 2);
  assert.equal(await getEventParticipant(a.id, 'victim'), null);
  assert.equal(await getEventParticipant(past.id, 'victim'), null);
  assert.ok(await getEventParticipant(a.id, 'bystander'), 'other members stay');
  assert.ok(await getEventParticipant(elsewhere.id, 'victim'), 'another server is untouched');
  assert.equal((await describeUserData(G, 'victim')).items.find((i) => i.key === 'eventSignups').count, 0);
});

test('forgetUser takes a former host off their events (the events stay); describeUserData and /mydata list them', async () => {
  await clearGuildEvents(G);
  await clearGuildEvents(H);
  const mine = await createEvent(ev({ hostId: 'victim', title: 'Mine' }));
  const theirs = await createEvent(ev({ hostId: 'bystander' }));
  const elsewhere = await createEvent(ev({ guildId: H, hostId: 'victim' }));

  const item = (await describeUserData(G, 'victim')).items.find((i) => i.key === 'eventsHosted');
  assert.equal(item.count, 1);
  assert.equal(item.kept, false);
  const exported = await exportUserData(G, 'victim');
  assert.equal(exported.data.eventsHosted.length, 1);
  assert.equal(exported.data.eventsHosted[0].title, 'Mine');

  const result = await forgetUser(G, 'victim');
  assert.equal(result.eventsHosted, 1);
  assert.equal((await getEvent(mine.id)).host_id, null);
  assert.equal((await getEvent(mine.id)).title, 'Mine', 'the event stays');
  assert.equal((await getEvent(theirs.id)).host_id, 'bystander');
  assert.equal((await getEvent(elsewhere.id)).host_id, 'victim', 'another server is untouched');
  assert.equal((await describeUserData(G, 'victim')).items.find((i) => i.key === 'eventsHosted').count, 0);
});

test('purgeGuild removes the events and their sign-ups; the table is on the guild list', async () => {
  assert.ok(GUILD_TABLES.includes('guild_events'));
  const a = await createEvent(ev());
  await setEventParticipant(a.id, 'u1', 'join');
  const keep = await createEvent(ev({ guildId: H }));
  await setEventParticipant(keep.id, 'u1', 'join');
  await purgeGuild(G);
  assert.equal(await getEvent(a.id), null);
  assert.equal(await eventParticipantCount(a.id), 0);
  assert.ok(await getEvent(keep.id));
  assert.equal(await eventParticipantCount(keep.id), 1);
  await clearGuildEvents(H);
  assert.equal(await eventParticipantCount(keep.id), 0);
});
