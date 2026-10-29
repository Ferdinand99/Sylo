// Events end to end with fake platform objects: /event create|list|cancel, the Join / Maybe / Leave
// buttons with a capacity, the participant role, reminders and endings, and a restart.
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { setGuildModule } from '../src/db/modules.js';
import { startSchedules, stopSchedules } from '../src/modules/schedule.js';
import {
  createEvent as insertEvent,
  eventParticipantIds,
  getEvent,
  getEventParticipant,
  setEventParticipant,
  upcomingEvents,
} from '../src/db/events.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import { execute } from '../src/bot/commands/event.js';
import { localToUtc, utcToLocalInput } from '../src/modules/lib/eventTime.js';
import { cancelEvent, createEvent, parseEventInput, tick, updateEvent } from '../src/modules/events.js';

// Every test gets its own server, so the events of one never show up in another.
let GID = '';
let seq = 0;
const CH = '100000000000000001';
const ROLE = '100000000000000700';
const HOST = '100000000000000999';
const U = ['100000000000000011', '100000000000000012', '100000000000000013', '100000000000000014'];
const MSG = '300000000000000001';
const HOUR = 3_600_000;

const settle = async () => {
  for (let i = 0; i < 25; i += 1) await new Promise((r) => setImmediate(r));
};

// Nothing queued by a click may run later against a different test's fake guild.
await stopSchedules();

function world({ dmClosed = [] } = {}) {
  GID = String(900000000000000100n + BigInt((seq += 1)));
  const out = { sent: [], edits: [], dms: [], roleCalls: [] };
  const message = {
    id: MSG,
    edit: async (p) => {
      out.edits.push(p);
      return message;
    },
  };
  const channel = {
    id: CH,
    isTextBased: () => true,
    send: async (p) => {
      out.sent.push(p);
      return message;
    },
    messages: { fetch: async (id) => (id === MSG ? message : null) },
  };
  const role = {
    id: ROLE,
    name: 'Going',
    position: 2,
    managed: false,
    editable: true,
    comparePositionTo: (other) => 2 - other.position,
  };
  const members = new Map();
  const member = (id) => {
    if (!members.has(id)) {
      const cache = new Map();
      members.set(id, {
        id,
        roles: {
          cache,
          highest: { position: 5, comparePositionTo: (r) => 5 - r.position },
          add: async (r) => {
            cache.set(r.id, r);
            out.roleCalls.push(['add', id]);
          },
          remove: async (r) => {
            cache.delete(r.id);
            out.roleCalls.push(['remove', id]);
          },
        },
        permissions: { has: () => false },
      });
    }
    return members.get(id);
  };
  const guild = {
    id: GID,
    ownerId: HOST,
    name: 'Test Guild',
    channels: { cache: new Map([[CH, channel]]), fetch: async (id) => (id === CH ? channel : null) },
    roles: { cache: new Map([[ROLE, role]]) },
    members: {
      me: {
        id: 'bot',
        permissions: { has: () => true },
        roles: { highest: { position: 10, comparePositionTo: (r) => 10 - r.position } },
      },
      cache: members,
      fetch: async (id) => members.get(id) ?? null,
    },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[GID, guild]]) },
    users: {
      fetch: async (id) => ({
        id,
        send: async (p) => {
          if (dmClosed.includes(id)) throw new Error('Cannot send messages to this user');
          out.dms.push({ id, p });
        },
      }),
    },
  };
  guild.client = client;
  runtime.clients.discord = client;
  return { ...out, guild, channel, role, member, message, out };
}

let w;
const fresh = (opts) => {
  w = world(opts);
  return w;
};

afterEach(async () => {
  mock.timers.reset();
  await stopSchedules();
  runtime.clients.discord = null;
});

const inHours = (h) => Date.now() + h * HOUR;
const utcText = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function enable(config = {}) {
  await setGuildModule(GID, 'events', { enabled: true, config });
}

async function newEvent(over = {}) {
  const { id } = await insertEvent({
    guildId: GID,
    channelId: CH,
    title: 'Game night',
    startAt: inHours(3),
    hostId: HOST,
    ...over,
  });
  await (await import('../src/db/events.js')).setEventMessage(id, MSG);
  return id;
}

function click(customId, userId) {
  const replies = [];
  return {
    customId,
    guildId: GID,
    guild: w.guild,
    user: { id: userId },
    member: w.member(userId),
    replied: false,
    deferred: false,
    isRepliable: () => true,
    reply: async (p) => {
      replies.push(p);
    },
    replies,
  };
}

async function press(choice, id, userId) {
  const i = click(`evt:${choice}:${id}`, userId);
  assert.equal(await routeComponent(i), true, 'the button is routed to the events module');
  return i.replies.map((r) => r.content).join('\n');
}

function slash(sub, values = {}, { perms = ['ManageEvents'], as = HOST } = {}) {
  const replies = [];
  const get = (name) => values[name] ?? null;
  return {
    guildId: GID,
    guild: w.guild,
    channelId: CH,
    user: { id: as },
    member: w.member(as),
    memberPermissions: { has: (p) => perms.includes(p) },
    options: {
      getSubcommand: () => sub,
      getString: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return get(n);
      },
      getInteger: (n) => get(n),
      getRole: (n) => get(n),
      getChannel: (n) => get(n),
    },
    reply: async (p) => {
      replies.push(p);
    },
    replies,
    text: () => replies.map((r) => r.content ?? '').join('\n'),
  };
}

// --- /event -----------------------------------------------------------------------------------

test('/event create: refused for someone who is not staff, and when the module is off', async () => {
  fresh();
  const off = slash('create', { title: 'x', start: utcText(inHours(2)) });
  await setGuildModule(GID, 'events', { enabled: false });
  await execute(off);
  assert.match(off.text(), /not enabled/);

  await enable();
  const nope = slash('create', { title: 'x', start: utcText(inHours(2)) }, { perms: [] });
  await execute(nope);
  assert.match(nope.text(), /Only staff/);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(nope.replies[0].flags & 64, 64, 'the refusal is ephemeral');
});

test('/event create: staff roles from the settings may create without Manage Events', async () => {
  fresh();
  await enable({ staffRoles: [ROLE] });
  const i = slash('create', { title: 'Staff event', start: utcText(inHours(2)) }, { perms: [] });
  i.member.roles.cache.set(ROLE, w.role);
  await execute(i);
  assert.match(i.text(), /is up in/);
});

test('/event create posts the embed with buttons, stores the event and answers privately', async () => {
  fresh();
  await enable({ reminderMinutes: 45, timeZone: 'Europe/Oslo' });
  const wall = utcToLocalInput(inHours(48), 'Europe/Oslo').replace('T', ' ');
  const i = slash('create', {
    title: 'Christmas quiz',
    start: wall,
    description: 'Teams of four',
    location: 'Voice 2',
    capacity: 12,
    role: w.role,
  });
  await execute(i);
  assert.match(i.text(), /Event \*\*#\d+\*\* is up in <#100000000000000001>/);
  assert.equal(w.sent.length, 1);
  const posted = w.sent[0];
  assert.equal(posted.embeds[0].toJSON().title, '📅 Christmas quiz');
  assert.equal(posted.components[0].toJSON().components.length, 3);

  const [ev] = await upcomingEvents(GID);
  assert.equal(ev.title, 'Christmas quiz');
  assert.equal(ev.start_at, localToUtc(wall, 'Europe/Oslo'), 'read in the server zone');
  assert.equal(ev.time_zone, 'Europe/Oslo');
  assert.equal(ev.capacity, 12);
  assert.equal(ev.role_id, ROLE);
  assert.equal(ev.reminder_minutes, 45, 'the server default reminder');
  assert.equal(ev.message_id, MSG);
  assert.equal(ev.host_id, HOST);
  assert.equal(ev.reminder_sent, false);
  await cancelEvent(ev.id, GID);
});

test('/event create explains a bad time instead of posting', async () => {
  fresh();
  await enable();
  const i = slash('create', { title: 'x', start: 'next friday' });
  await execute(i);
  assert.match(i.text(), /Could not read the start time/);
  const past = slash('create', { title: 'x', start: '2020-01-01 10:00' });
  await execute(past);
  assert.match(past.text(), /in the future/);
  assert.equal(w.sent.length, 0);
});

test('/event create refuses a participant role the creator may not hand out', async () => {
  fresh();
  await enable();
  const i = slash('create', { title: 'x', start: utcText(inHours(2)), role: w.role }, { as: U[0] });
  // not the owner, no Administrator, and the role is not below their highest role
  i.member.roles.highest = { position: 1, comparePositionTo: (r) => 1 - r.position };
  i.member.permissions = { has: () => false };
  await execute(i);
  assert.match(i.text(), /above or equal to your highest role/);
  assert.equal(w.sent.length, 0);
});

test('/event create stops at 50 upcoming events, and still lets a cancelled one make room', async () => {
  fresh();
  await enable();
  const before = (await upcomingEvents(GID)).length;
  const ids = [];
  for (let n = before; n < CEILINGS.events; n += 1) ids.push(await newEvent({ title: `filler ${n}` }));
  const i = slash('create', { title: 'one too many', start: utcText(inHours(2)) });
  await execute(i);
  assert.match(i.text(), /maximum of 50 upcoming events/);
  assert.equal(w.sent.length, 0);

  assert.equal((await cancelEvent(ids[0], GID)).ok, true);
  const ok = slash('create', { title: 'now it fits', start: utcText(inHours(2)) });
  await execute(ok);
  assert.match(ok.text(), /is up in/);
  for (const id of ids.slice(1)) await cancelEvent(id, GID);
});

test('/event list shows the upcoming events with their counts; /event cancel cancels one', async () => {
  fresh();
  await enable();
  for (const e of await upcomingEvents(GID)) await cancelEvent(e.id, GID);
  const empty = slash('list');
  await execute(empty);
  assert.match(empty.text(), /No upcoming events/);

  const id = await newEvent({ title: 'Movie night', capacity: 5 });
  await setEventParticipant(id, U[0], 'join');
  await setEventParticipant(id, U[1], 'maybe');
  const list = slash('list');
  await execute(list);
  const desc = list.replies[0].embeds[0].toJSON().description;
  assert.match(desc, new RegExp(`#${id}\\*\\* · Movie night`));
  assert.match(desc, /✅ 1\/5 · ❔ 1/);

  const bad = slash('cancel', { id: 999999 });
  await execute(bad);
  assert.match(bad.text(), /No such event/);

  const cancel = slash('cancel', { id });
  await execute(cancel);
  assert.match(cancel.text(), /is cancelled/);
  assert.equal((await getEvent(id)).state, 'cancelled');
  const again = slash('cancel', { id });
  await execute(again);
  assert.match(again.text(), /already over/);
  const denied = slash('list', {}, { perms: [] });
  await execute(denied);
  assert.match(denied.text(), /Only staff/);
});

test('createEvent: when the post cannot be made nothing is left behind', async () => {
  fresh();
  await enable();
  w.channel.send = async () => {
    throw new Error('Missing Access');
  };
  const before = (await upcomingEvents(GID)).length;
  const input = parseEventInput({ title: 'x', start: utcText(inHours(2)) }).value;
  const r = await createEvent({ guild: w.guild, hostId: HOST, channelId: CH, input });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not post/);
  assert.equal((await upcomingEvents(GID)).length, before);

  w.channel.send = async (p) => {
    w.sent.push(p);
    return w.message;
  };
  w.role.editable = false;
  const refused = await createEvent({ guild: w.guild, hostId: HOST, channelId: CH, roleId: ROLE, input });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cannot hand out that role/);
  assert.equal(w.sent.length, 0);
});

// --- the buttons ------------------------------------------------------------------------------

test('Join, Maybe and Leave with a capacity: full events refuse Join, Maybe still works', async () => {
  fresh();
  await enable();
  const id = await newEvent({ capacity: 2, roleId: ROLE });

  assert.match(await press('join', id, U[0]), /You're going/);
  assert.match(await press('join', id, U[1]), /You're going/);
  assert.match(await press('join', id, U[0]), /already going/);
  assert.match(await press('join', id, U[2]), /is full \(2\/2\)/);
  assert.equal(await getEventParticipant(id, U[2]), null, 'a refused Join stores nothing');
  assert.equal(w.member(U[2]).roles.cache.has(ROLE), false, 'and gives no role');

  assert.match(await press('maybe', id, U[2]), /Marked as maybe/);
  assert.equal((await getEventParticipant(id, U[2])).status, 'maybe');
  assert.match(await press('maybe', id, U[2]), /already marked/);

  assert.match(await press('leave', id, U[0]), /You left/);
  assert.match(await press('leave', id, U[0]), /not signed up/);
  assert.match(await press('join', id, U[2]), /You're going/, 'the freed place can be taken');
  assert.deepEqual((await eventParticipantIds(id, 'join')).sort(), [U[1], U[2]].sort());
  assert.deepEqual(await eventParticipantIds(id, 'maybe'), []);
});

test('the participant role follows Join: given on Join, taken back on Maybe and Leave', async () => {
  fresh();
  await enable();
  const id = await newEvent({ roleId: ROLE });
  await press('join', id, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), true);
  await press('maybe', id, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), false);
  await press('join', id, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), true);
  await press('leave', id, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), false);
  assert.deepEqual(w.roleCalls, [
    ['add', U[0]],
    ['remove', U[0]],
    ['add', U[0]],
    ['remove', U[0]],
  ]);
});

test('Join still works when Sylo may not hand out the role, and says so', async () => {
  fresh();
  await enable();
  const id = await newEvent({ roleId: ROLE });
  w.role.editable = false;
  const reply = await press('join', id, U[0]);
  assert.match(reply, /could not give you the event role/);
  assert.equal((await getEventParticipant(id, U[0])).status, 'join');
});

test('a click on an ended, cancelled, unknown or disabled event is answered privately and stores nothing', async () => {
  fresh();
  await enable();
  const ended = await newEvent();
  await tick(inHours(10));
  assert.match(await press('join', ended, U[0]), /over/);
  const cancelled = await newEvent();
  await cancelEvent(cancelled, GID);
  assert.match(await press('join', cancelled, U[0]), /cancelled/);
  assert.match(await press('join', 999999, U[0]), /no longer exists/);

  const live = await newEvent();
  await setGuildModule(GID, 'events', { enabled: false });
  assert.match(await press('join', live, U[0]), /disabled/);
  assert.equal(await getEventParticipant(live, U[0]), null);
  await enable();

  const other = await newEvent({ guildId: '900000000000009999' });
  assert.match(await press('join', other, U[0]), /no longer exists/, 'an event of another server');
  const junk = click('evt:join:abc', U[0]);
  await routeComponent(junk);
  assert.deepEqual(junk.replies, []);
});

test('at 500 sign-ups a new person is refused, someone already signed up may still change their answer', async () => {
  fresh();
  await enable();
  const id = await newEvent();
  for (let n = 0; n < CEILINGS.eventParticipants; n += 1) {
    await setEventParticipant(id, String(200000000000000000n + BigInt(n)), 'maybe');
  }
  assert.match(await press('join', id, U[0]), /limit of 500 sign-ups/);
  assert.equal(await getEventParticipant(id, U[0]), null);
  assert.match(await press('join', id, '200000000000000000'), /You're going/);
});

test('a burst of clicks produces one edit of the post, showing everyone', async () => {
  fresh();
  await enable();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  startSchedules();
  const id = await newEvent();
  await press('join', id, U[0]);
  await press('join', id, U[1]);
  await press('maybe', id, U[2]);
  await press('leave', id, U[1]);
  assert.equal(w.edits.length, 0, 'nothing is edited per click');
  mock.timers.tick(3000);
  await settle();
  assert.equal(w.edits.length, 1);
  const fields = w.edits[0].embeds[0].toJSON().fields;
  assert.equal(fields[0].name, '✅ Going (1)');
  assert.equal(fields[0].value, `<@${U[0]}>`);
  assert.equal(fields[1].value, `<@${U[2]}>`);
});

// --- edit, reminders and endings --------------------------------------------------------------

test('updateEvent changes the fields and the posted message; ended events and other servers are refused', async () => {
  fresh();
  await enable();
  const id = await newEvent({ reminderMinutes: 60 });
  const r = await updateEvent(id, GID, {
    title: 'Renamed',
    start: utcText(inHours(5)),
    timeZone: 'UTC',
    capacity: 4,
    reminderMinutes: 30,
    location: 'Somewhere',
  });
  assert.equal(r.ok, true);
  const ev = await getEvent(id);
  assert.equal(ev.title, 'Renamed');
  assert.equal(ev.capacity, 4);
  assert.equal(ev.reminder_minutes, 30);
  assert.equal(ev.reminder_sent, false, 'a start far enough ahead keeps the reminder due');
  assert.equal(w.edits.length, 1);
  assert.equal(w.edits[0].embeds[0].toJSON().title, '📅 Renamed');

  // moving the start into the reminder window sends no reminder at once
  await updateEvent(id, GID, {
    title: 'Renamed',
    start: utcText(inHours(0.2)),
    timeZone: 'UTC',
    reminderMinutes: 60,
  });
  assert.equal((await getEvent(id)).reminder_sent, true);

  assert.equal(
    (await updateEvent(id, '900000000000009999', { title: 'x', start: utcText(inHours(1)) })).status,
    404
  );
  const bad = await updateEvent(id, GID, { title: '', start: utcText(inHours(1)) });
  assert.equal(bad.ok, false);
  await tick(inHours(10));
  const late = await updateEvent(id, GID, { title: 'x', start: utcText(inHours(20)) });
  assert.match(late.error, /Only upcoming events/);
});

test('the reminder goes to the channel (pinging the role) and as a DM to Join only, once', async () => {
  fresh({ dmClosed: [U[1]] });
  await enable({ dmReminders: true });
  const start = inHours(1.5);
  const id = await newEvent({ startAt: start, reminderMinutes: 60, roleId: ROLE, location: 'Voice 1' });
  await press('join', id, U[0]);
  await press('join', id, U[1]); // DMs closed
  await press('maybe', id, U[2]);
  w.sent.length = 0;

  await tick(start - 61 * 60_000);
  assert.equal(w.sent.length, 0, 'not yet');
  await tick(start - 59 * 60_000);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].content, /Game night/);
  assert.match(w.sent[0].content, new RegExp(`<@&${ROLE}>`));
  assert.deepEqual(w.sent[0].allowedMentions, { parse: [], roles: [ROLE] });
  assert.deepEqual(
    w.dms.map((d) => d.id),
    [U[0]],
    'a DM to the one who joined and can be reached'
  );
  await tick(start - 58 * 60_000);
  assert.equal(w.sent.length, 1, 'sent once');
  assert.equal(w.dms.length, 1);
});

test('no DMs unless enabled, no reminder when off, and none for an event that already started', async () => {
  fresh();
  await enable({ dmReminders: false });
  const start = inHours(1.5);
  const a = await newEvent({ startAt: start, reminderMinutes: 60 });
  const off = await newEvent({ startAt: start, reminderMinutes: 0 });
  await press('join', a, U[0]);
  w.sent.length = 0;
  await tick(start - 30 * 60_000);
  assert.equal(w.sent.length, 1);
  assert.equal(w.dms.length, 0);
  assert.equal((await getEvent(off)).reminder_sent, false);

  const missed = await newEvent({ startAt: start, reminderMinutes: 60 });
  w.sent.length = 0;
  await tick(start + 5 * 60_000); // the bot was down through the whole window
  assert.equal(
    w.sent.filter((s) => /Game night/.test(s.content ?? '') && /starts/.test(s.content)).length,
    0
  );
  assert.equal((await getEvent(missed)).reminder_sent, true, 'marked so it is not retried');
});

test('an event ends at its end time (or 2 h after the start) and everybody loses the role', async () => {
  fresh();
  await enable();
  const start = inHours(1);
  const withEnd = await newEvent({ startAt: start, endAt: start + 3 * HOUR, roleId: ROLE });
  const noEnd = await newEvent({ startAt: start, roleId: ROLE });
  for (const id of [withEnd, noEnd]) {
    await press('join', id, U[0]);
    await press('join', id, U[1]);
    await press('maybe', id, U[2]);
  }
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), true);

  await tick(start + 119 * 60_000);
  assert.equal((await getEvent(noEnd)).state, 'scheduled');
  await tick(start + 121 * 60_000);
  assert.equal((await getEvent(noEnd)).state, 'ended', 'no end time: over 2 h after the start');
  assert.equal((await getEvent(withEnd)).state, 'scheduled', 'a set end time is respected');
  assert.equal(
    w.member(U[0]).roles.cache.has(ROLE),
    true,
    'the other event still holds the role for these people'
  );

  await tick(start + 181 * 60_000);
  assert.equal((await getEvent(withEnd)).state, 'ended');
  for (const u of [U[0], U[1], U[2]]) assert.equal(w.member(u).roles.cache.has(ROLE), false, u);
  const last = w.edits.at(-1).embeds[0].toJSON();
  assert.match(last.title, /\(ended\)/);
  assert.deepEqual(w.edits.at(-1).components, []);
  await tick(start + 200 * 60_000);
  assert.equal(w.roleCalls.filter(([k]) => k === 'remove').length >= 2, true);
});

test('cancelling takes the role back, edits the post and posts a notice that pings only the role', async () => {
  fresh();
  await enable();
  const id = await newEvent({ roleId: ROLE });
  await press('join', id, U[0]);
  await press('join', id, U[1]);
  w.sent.length = 0;
  const r = await cancelEvent(id, GID);
  assert.equal(r.ok, true);
  assert.equal((await getEvent(id)).state, 'cancelled');
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), false);
  assert.equal(w.member(U[1]).roles.cache.has(ROLE), false);
  assert.match(w.edits.at(-1).embeds[0].toJSON().title, /\(cancelled\)/);
  assert.match(w.sent[0].content, /has been cancelled/);
  assert.deepEqual(w.sent[0].allowedMentions, { parse: [], roles: [ROLE] });
  assert.equal((await cancelEvent(id, GID)).ok, false, 'a second cancel does nothing');
  assert.equal((await cancelEvent(id, '900000000000009999')).ok, false, 'another server cannot cancel it');
});

// --- the schedule registry and a restart ------------------------------------------------------

test('the events tick runs from the schedule registry, and a restart picks up what came due meanwhile', async () => {
  fresh();
  await enable();
  const t0 = Date.now();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: t0 });
  const start = t0 + 2 * HOUR;
  const id = await newEvent({ startAt: start, reminderMinutes: 60, roleId: ROLE });
  await press('join', id, U[0]);
  w.sent.length = 0;

  // first run of the bot: nothing is due yet
  startSchedules();
  mock.timers.tick(30_000);
  await settle();
  assert.equal(w.sent.length, 0);
  await stopSchedules();

  // the bot is down for 90 minutes, then starts again: the reminder window has opened
  mock.timers.setTime(t0 + 90 * 60_000);
  startSchedules();
  mock.timers.tick(30_000);
  await settle();
  assert.equal(w.sent.length, 1, 'the missed reminder is sent after the restart');
  assert.match(w.sent[0].content, /starts/);
  mock.timers.tick(30_000);
  await settle();
  assert.equal(w.sent.length, 1, 'and only once');
  await stopSchedules();

  // down again until after the event: it is closed and the role taken back
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), true);
  mock.timers.setTime(start + 3 * HOUR);
  startSchedules();
  mock.timers.tick(30_000);
  await settle();
  assert.equal((await getEvent(id)).state, 'ended');
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), false);
});

test('the tick does nothing while a platform client is not ready', async () => {
  fresh();
  await enable();
  const start = inHours(1);
  const id = await newEvent({ startAt: start, reminderMinutes: 60 });
  runtime.clients.discord.isReady = () => false;
  await tick(start + 10 * HOUR);
  assert.equal((await getEvent(id)).state, 'scheduled');
  runtime.clients.discord.isReady = () => true;
  await tick(start + 10 * HOUR);
  assert.equal((await getEvent(id)).state, 'ended');
});

test('two events that hand out the same role: leaving one keeps the role while going to the other', async () => {
  fresh();
  await enable();
  const a = await newEvent({ roleId: ROLE });
  const b = await newEvent({ roleId: ROLE });
  await press('join', a, U[0]);
  await press('join', b, U[0]);
  await press('leave', a, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), true, 'still going to b');
  await press('leave', b, U[0]);
  assert.equal(w.member(U[0]).roles.cache.has(ROLE), false);
});
