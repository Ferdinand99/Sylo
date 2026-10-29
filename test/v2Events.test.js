// The Events page of the new dashboard: settings, create, edit and cancel through /api/v2, with the
// side effects (stored rows, the posted message, audit rows) asserted. Who may call these routes,
// and the CSRF header, are in v2.permissions*.test.js and v2Events.auth.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { createEvent, getEvent, upcomingEvents } from '../src/db/events.js';
import { LIMITS } from '../src/lib/limits.js';
import { localToUtc } from '../src/modules/lib/eventTime.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const json = async (res) => res.json();
const future = (days) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16).replace('T', ' ');
const body = (over = {}) => ({
  title: 'Game night',
  description: 'Bring snacks',
  start: future(3),
  timeZone: 'Europe/Oslo',
  channelId: CH.general,
  capacity: 8,
  reminderMinutes: 30,
  location: 'Voice 1',
  ...over,
});

test('GET config: defaults, the channel and role lists, no events yet', async () => {
  const res = await api.get('/modules/events/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.config, {
    channel: '',
    reminderMinutes: 60,
    staffRoles: [],
    dmReminders: false,
    timeZone: '',
  });
  assert.ok(data.channels.some((c) => c.id === CH.general));
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.deepEqual(data.events, []);
});

test('POST config stores the normalised settings and writes an audit row', async () => {
  const res = await api.post('/modules/events/config', {
    channel: CH.announce,
    reminderMinutes: 2,
    staffRoles: [ROLE.admin, 'junk'],
    dmReminders: true,
    timeZone: 'europe/oslo',
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'events')).config;
  assert.deepEqual(stored, {
    channel: CH.announce,
    reminderMinutes: 5,
    staffRoles: [ROLE.admin],
    dmReminders: true,
    timeZone: 'Europe/Oslo',
  });
  assert.deepEqual((await json(await api.get('/modules/events/config'))).config, stored);
  const audit = (await auditRows(GID, 'module:events'))[0];
  assert.equal(audit.detail, 'settings saved');
  assert.equal(audit.actor, 'Dashboard');
  await api.post('/modules/events/config', { channel: '', reminderMinutes: 60 });
});

test('creating an event while the module is off is refused', async () => {
  await setGuildModule(GID, 'events', { enabled: false });
  const res = await api.post('/modules/events/events', body());
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /Turn the Events module on/);
  assert.equal((await upcomingEvents(GID)).length, 0);
});

let eventId;
test('creating an event stores it, posts the embed with buttons and lists it', async () => {
  await setGuildModule(GID, 'events', { enabled: true });
  app.sink.messages.length = 0;
  const res = await api.post('/modules/events/events', body({ roleId: ROLE.member }));
  assert.equal(res.status, 200);
  const { events } = await json(res);
  assert.equal(events.length, 1);
  const e = events[0];
  eventId = e.id;
  assert.equal(e.title, 'Game night');
  assert.equal(e.timeZone, 'Europe/Oslo');
  assert.equal(e.startAt, localToUtc(body().start, 'Europe/Oslo'));
  assert.equal(e.start, body().start.replace(' ', 'T'), 'the time as set, ready for a datetime-local input');
  assert.equal(e.capacity, 8);
  assert.equal(e.reminderMinutes, 30);
  assert.equal(e.roleId, ROLE.member);
  assert.equal(e.channel, 'general');
  assert.equal(e.state, 'scheduled');
  assert.equal(e.joined, 0);

  assert.equal(app.sink.messages.length, 1);
  assert.equal(app.sink.messages[0].channel, CH.general);
  const payload = app.sink.messages[0].payload;
  assert.equal(payload.embeds[0].toJSON().title, '📅 Game night');
  assert.equal(payload.components[0].toJSON().components.length, 3);

  const row = await getEvent(eventId);
  assert.equal(row.message_id, 'msg-1');
  assert.equal(row.host_id, 'owner-id', 'open mode attributes it to the server owner');
  const audit = (await auditRows(GID, 'module:events')).find((a) => a.detail === `created #${eventId}`);
  assert.ok(audit);
});

test('the default channel and reminder come from the settings when the form leaves them out', async () => {
  await setGuildModule(GID, 'events', {
    enabled: true,
    config: { channel: CH.bots, reminderMinutes: 90 },
  });
  app.sink.messages.length = 0;
  const res = await api.post('/modules/events/events', body({ channelId: '', reminderMinutes: undefined }));
  assert.equal(res.status, 200);
  assert.equal(app.sink.messages[0].channel, CH.bots);
  const made = (await json(res)).events.find((e) => e.channelId === CH.bots);
  assert.equal(made.reminderMinutes, 90);
  await setGuildModule(GID, 'events', { enabled: true, config: {} });
});

test('create explains what is wrong and stores nothing', async () => {
  const before = (await upcomingEvents(GID)).length;
  const cases = [
    [{ title: '' }, /title/i],
    [{ start: '' }, /start time/i],
    [{ start: 'whenever' }, /Could not read the start/],
    [{ start: '2020-01-01 10:00' }, /in the future/],
    [{ timeZone: 'Mars/Base' }, /Unknown time zone/],
    [{ end: future(2) }, /after the start/],
    [{ imageUrl: 'http://insecure.example/a.png' }, /https/],
    [{ channelId: '100000000000009999' }, /Pick a text channel/],
    [{ channelId: CH.voice }, /Pick a text channel/],
    [{ roleId: '100000000000009999' }, /Pick a role/],
    [{ roleId: ROLE.bot }, /Pick a role/],
  ];
  for (const [over, message] of cases) {
    const res = await api.post('/modules/events/events', body(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match((await json(res)).error, message, JSON.stringify(over));
  }
  assert.equal((await upcomingEvents(GID)).length, before);
});

test('editing changes the stored event (the posted message edit is in events.flow.test.js)', async () => {
  const res = await api.post(`/modules/events/events/${eventId}`, {
    ...body({ title: 'Renamed', start: future(4), capacity: '' }),
    channelId: CH.bots,
    roleId: '',
  });
  assert.equal(res.status, 200);
  const e = (await json(res)).events.find((x) => x.id === eventId);
  assert.equal(e.title, 'Renamed');
  assert.equal(e.capacity, null);
  assert.equal(e.roleId, ROLE.member, 'the participant role cannot be changed');
  assert.equal(e.channelId, CH.general, 'and neither can the channel');
  assert.ok((await auditRows(GID, 'module:events')).some((a) => a.detail === `edited #${eventId}`));

  const bad = await api.post(`/modules/events/events/${eventId}`, body({ start: '2020-01-01 10:00' }));
  assert.equal(bad.status, 400);
  assert.equal((await getEvent(eventId)).title, 'Renamed');
  const missing = await api.post('/modules/events/events/999999', body());
  assert.equal(missing.status, 404);
  assert.match((await json(missing)).error, /No such event/);
});

test('cancelling marks the event, lists it as past, and a second cancel is refused', async () => {
  const res = await api.post(`/modules/events/events/${eventId}/cancel`);
  assert.equal(res.status, 200);
  const e = (await json(res)).events.find((x) => x.id === eventId);
  assert.equal(e.state, 'cancelled');
  assert.equal((await getEvent(eventId)).state, 'cancelled');
  assert.ok((await auditRows(GID, 'module:events')).some((a) => a.detail === `cancelled #${eventId}`));

  assert.equal((await api.post(`/modules/events/events/${eventId}/cancel`)).status, 400);
  assert.equal((await api.post('/modules/events/events/999999/cancel')).status, 404);
  const edit = await api.post(`/modules/events/events/${eventId}`, body());
  assert.match((await json(edit)).error, /Only upcoming events/);
});

test('the list shows upcoming events first, then recent past ones with their sign-up counts', async () => {
  const { setEventParticipant } = await import('../src/db/events.js');
  const live = (await upcomingEvents(GID))[0];
  await setEventParticipant(live.id, '111', 'join');
  await setEventParticipant(live.id, '222', 'maybe');
  const { events } = await json(await api.get('/modules/events/config'));
  const states = events.map((e) => e.state);
  assert.ok(states.indexOf('cancelled') > states.lastIndexOf('scheduled'), 'upcoming before past');
  const row = events.find((e) => e.id === live.id);
  assert.equal(row.joined, 1);
  assert.equal(row.maybe, 1);
});

test('past 50 upcoming events a create is a 400 with the reason', async () => {
  for (let n = (await upcomingEvents(GID)).length; n < LIMITS.events; n += 1) {
    await createEvent({
      guildId: GID,
      channelId: CH.general,
      title: `filler ${n}`,
      startAt: Date.now() + 5 * 86_400_000,
      hostId: 'h',
    });
  }
  const res = await api.post('/modules/events/events', body());
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /maximum of 50 upcoming events/);
});
