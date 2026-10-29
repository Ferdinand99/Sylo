// Events, the parts that need no database: time zones, the settings and field normalisers, input
// checking, the staff check and the posted message.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  buildEventPayload,
  canManageEvents,
  clampReminder,
  normaliseEventFields,
  normaliseEventsConfig,
  parseEventInput,
} from '../src/modules/events.js';
import {
  canonicalTimeZone,
  formatInZone,
  localToUtc,
  utcToLocalInput,
} from '../src/modules/lib/eventTime.js';

const ROLE = '100000000000000700';
const NOW = Date.UTC(2026, 9, 29, 12, 0); // 29 Oct 2026, 12:00 UTC

// --- time zones -------------------------------------------------------------------------------

test('localToUtc reads a wall-clock time in a zone, with winter and summer offsets', () => {
  assert.equal(
    new Date(localToUtc('2026-11-05 19:00', 'Europe/Oslo')).toISOString(),
    '2026-11-05T18:00:00.000Z'
  );
  assert.equal(
    new Date(localToUtc('2026-07-05T19:00', 'Europe/Oslo')).toISOString(),
    '2026-07-05T17:00:00.000Z'
  );
  assert.equal(
    new Date(localToUtc('2026-11-05 19:00', 'Asia/Kolkata')).toISOString(),
    '2026-11-05T13:30:00.000Z'
  );
  assert.equal(new Date(localToUtc('2026-11-05 19:00', 'UTC')).toISOString(), '2026-11-05T19:00:00.000Z');
});

test('localToUtc refuses text that is not a time, dates that do not exist and times skipped by a clock change', () => {
  assert.equal(localToUtc('tomorrow', 'UTC'), null);
  assert.equal(localToUtc('2026-02-31 10:00', 'UTC'), null);
  assert.equal(localToUtc('2026-11-05 24:00', 'UTC'), null);
  assert.equal(localToUtc('2026-11-05 19:60', 'UTC'), null);
  // Norway skips 02:00-03:00 on 29 March 2026
  assert.equal(localToUtc('2026-03-29 02:30', 'Europe/Oslo'), null);
  assert.ok(localToUtc('2026-03-29 03:30', 'Europe/Oslo') > 0);
});

test('a time that happens twice in a zone still resolves to one of the two instants', () => {
  const at = localToUtc('2026-10-25 02:30', 'Europe/Oslo'); // clocks go back at 03:00
  assert.ok([Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)].includes(at));
});

test('utcToLocalInput and localToUtc round-trip', () => {
  const ms = Date.UTC(2026, 11, 24, 21, 15);
  for (const zone of ['Europe/Oslo', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
    assert.equal(localToUtc(utcToLocalInput(ms, zone), zone), ms, zone);
  }
  assert.equal(utcToLocalInput(Date.UTC(2026, 10, 5, 18, 0), 'Europe/Oslo'), '2026-11-05T19:00');
  assert.match(formatInZone(Date.UTC(2026, 10, 5, 18, 0), 'Europe/Oslo'), /Thu.*5 Nov 2026.*19:00/);
});

test('canonicalTimeZone accepts IANA names, fixes their case and refuses everything else', () => {
  assert.equal(canonicalTimeZone('europe/oslo'), 'Europe/Oslo');
  assert.equal(canonicalTimeZone(' UTC '), 'UTC');
  for (const bad of [
    '',
    null,
    undefined,
    'Nope/Zone',
    '+01:00',
    '-05:00',
    'a'.repeat(80),
    'Europe/Oslo; DROP',
  ]) {
    assert.equal(canonicalTimeZone(bad), null, String(bad));
  }
});

// --- settings and fields ----------------------------------------------------------------------

test('normaliseEventsConfig: defaults, a reminder inside the limits, ids and a valid zone only', () => {
  assert.deepEqual(normaliseEventsConfig(), {
    channel: '',
    reminderMinutes: 60,
    staffRoles: [],
    dmReminders: false,
    timeZone: '',
  });
  const c = normaliseEventsConfig({
    channel: '100000000000000001',
    reminderMinutes: 3,
    staffRoles: [ROLE, 'junk', ROLE],
    dmReminders: 1,
    timeZone: 'europe/oslo',
  });
  assert.equal(c.channel, '100000000000000001');
  assert.equal(c.reminderMinutes, LIMITS.reminderMinutes.min);
  assert.deepEqual(c.staffRoles, [ROLE]);
  assert.equal(c.dmReminders, true);
  assert.equal(c.timeZone, 'Europe/Oslo');
  assert.equal(normaliseEventsConfig({ reminderMinutes: 0 }).reminderMinutes, 0);
  assert.equal(normaliseEventsConfig({ timeZone: 'Mars/Base' }).timeZone, '');
  assert.equal(normaliseEventsConfig({ channel: 'abc' }).channel, '');
});

test('clampReminder: 0 or unreadable is off, anything else lands inside 5..1440', () => {
  assert.equal(clampReminder(0), 0);
  assert.equal(clampReminder('x'), 0);
  assert.equal(clampReminder(-5), 0);
  assert.equal(clampReminder(1), 5);
  assert.equal(clampReminder(5), 5);
  assert.equal(clampReminder(90.9), 90);
  assert.equal(clampReminder(1440), 1440);
  assert.equal(clampReminder(99999), 1440);
});

test('normaliseEventFields: trims and cuts text, capacity is none or 1..500, the image must be a short https link', () => {
  const f = normaliseEventFields({
    title: '  Game night  ',
    description: 'd',
    location: 'l',
    imageUrl: 'https://example.com/a.png',
    capacity: '12',
    reminderMinutes: '30',
  });
  assert.deepEqual(f, {
    title: 'Game night',
    description: 'd',
    location: 'l',
    imageUrl: 'https://example.com/a.png',
    capacity: 12,
    reminderMinutes: 30,
  });
  for (const none of [undefined, null, '', 0, '0', -3, 'many']) {
    assert.equal(normaliseEventFields({ capacity: none }).capacity, null, String(none));
  }
  assert.equal(normaliseEventFields({ capacity: 9999 }).capacity, LIMITS.capacity.max);
  for (const bad of [
    'http://example.com/a.png',
    'ftp://x/y',
    'javascript:alert(1)',
    'https://a b',
    'example.com',
  ]) {
    assert.equal(normaliseEventFields({ imageUrl: bad }).imageUrl, '', bad);
  }
});

// --- input checking ---------------------------------------------------------------------------

const good = { title: 'Game night', start: '2026-11-05 19:00', timeZone: 'Europe/Oslo' };

test('parseEventInput turns a valid request into UTC times, a zone and clamped fields', () => {
  const r = parseEventInput(
    { ...good, end: '2026-11-05 22:00', capacity: 10, reminderMinutes: 30 },
    { now: NOW }
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.startAt, Date.UTC(2026, 10, 5, 18, 0));
  assert.equal(r.value.endAt, Date.UTC(2026, 10, 5, 21, 0));
  assert.equal(r.value.timeZone, 'Europe/Oslo');
  assert.equal(r.value.capacity, 10);
  assert.equal(r.value.reminderMinutes, 30);
});

test('parseEventInput uses the server defaults when the request names no zone or reminder', () => {
  const r = parseEventInput(
    { title: 'x', start: '2026-11-05 19:00' },
    { now: NOW, defaults: { timeZone: 'America/New_York', reminderMinutes: 45 } }
  );
  assert.equal(r.value.timeZone, 'America/New_York');
  assert.equal(r.value.startAt, Date.UTC(2026, 10, 6, 0, 0));
  assert.equal(r.value.reminderMinutes, 45);
  // an explicit 0 turns the reminder off even when the server default is on
  assert.equal(
    parseEventInput(
      { title: 'x', start: '2026-11-05 19:00', reminderMinutes: 0 },
      { now: NOW, defaults: { reminderMinutes: 45 } }
    ).value.reminderMinutes,
    0
  );
  // no zone anywhere: UTC
  assert.equal(
    parseEventInput({ title: 'x', start: '2026-11-05 19:00' }, { now: NOW }).value.timeZone,
    'UTC'
  );
});

test('parseEventInput explains what is wrong', () => {
  const err = (raw, opts) => {
    const r = parseEventInput(raw, { now: NOW, ...opts });
    assert.equal(r.ok, false, JSON.stringify(raw));
    return r.error;
  };
  assert.match(err({ ...good, title: '  ' }), /title/i);
  assert.match(err({ ...good, start: '' }), /start time/i);
  assert.match(err({ ...good, start: 'soon' }), /Could not read the start/);
  assert.match(err({ ...good, timeZone: 'Mars/Base' }), /Unknown time zone/);
  assert.match(err({ ...good, start: '2026-10-01 10:00' }), /in the future/);
  assert.match(err({ ...good, end: '2026-11-05 18:00' }), /after the start/);
  assert.match(err({ ...good, end: 'later' }), /Could not read the end/);
  assert.match(err({ ...good, imageUrl: 'http://x.example/a.png' }), /https/);
  assert.match(err({ ...good, imageUrl: `https://${'a'.repeat(LIMITS.imageUrl.maxLength)}` }), /https/);
});

test('parseEventInput: an edit may keep a start that is already past, but not move it there', () => {
  const existing = { time_zone: 'Europe/Oslo', start_at: Date.UTC(2026, 9, 29, 11, 0), end_at: null };
  const kept = parseEventInput({ title: 'x', start: '2026-10-29 12:00' }, { now: NOW, existing });
  assert.equal(kept.ok, true);
  assert.equal(kept.value.timeZone, 'Europe/Oslo', 'the stored zone stays when none is given');
  const moved = parseEventInput({ title: 'x', start: '2026-10-29 11:00' }, { now: NOW, existing });
  assert.equal(moved.ok, false);
});

// --- who may manage events --------------------------------------------------------------------

test('canManageEvents: Manage Events, Manage Server or Administrator, or a staff role', () => {
  const perms = (...names) => ({ has: (n) => names.includes(n) });
  const member = (...roles) => ({ roles: { cache: new Map(roles.map((r) => [r, {}])) } });
  assert.equal(canManageEvents(member(), perms('ManageEvents'), {}), true);
  assert.equal(canManageEvents(member(), perms('ManageGuild'), {}), true);
  assert.equal(canManageEvents(member(), perms('Administrator'), {}), true);
  assert.equal(canManageEvents(member(), perms('SendMessages'), {}), false);
  assert.equal(canManageEvents(member(ROLE), perms(), { staffRoles: [ROLE] }), true);
  assert.equal(canManageEvents(member('100000000000000701'), perms(), { staffRoles: [ROLE] }), false);
  assert.equal(canManageEvents(null, null, { staffRoles: [ROLE] }), false);
  // a platform that does not know a permission name throws; that is a "no", not a crash
  const strict = {
    has: (n) => {
      if (n === 'ManageEvents') throw new RangeError('unknown');
      return n === 'ManageGuild';
    },
  };
  assert.equal(canManageEvents(member(), strict, {}), true);
});

// --- the message ------------------------------------------------------------------------------

const row = (over = {}) => ({
  id: 7,
  guild_id: '900000000000000123',
  channel_id: '100000000000000001',
  title: 'Game night',
  description: 'Bring snacks',
  location: 'Voice 1',
  image_url: '',
  start_at: Date.UTC(2026, 10, 5, 18, 0),
  end_at: Date.UTC(2026, 10, 5, 21, 0),
  time_zone: 'Europe/Oslo',
  capacity: 3,
  role_id: ROLE,
  host_id: '222222222222222222',
  state: 'scheduled',
  ...over,
});

test('buildEventPayload: an open event shows the time, the host and the three buttons', () => {
  const p = buildEventPayload(row(), { joined: ['111111111111111111'], maybe: [] });
  const e = p.embeds[0].toJSON();
  assert.equal(e.title, '📅 Game night');
  assert.match(e.description, /Bring snacks/);
  assert.match(e.description, new RegExp(`<t:${Math.floor(row().start_at / 1000)}:F>`));
  assert.match(e.description, /Thu 5 Nov 2026, 19:00 \(Europe\/Oslo\)/);
  assert.match(e.description, /Voice 1/);
  assert.match(e.description, /<@222222222222222222>/);
  assert.match(e.description, new RegExp(`<@&${ROLE}>`));
  assert.equal(e.fields[0].name, '✅ Going (1/3)');
  assert.equal(e.fields[0].value, '<@111111111111111111>');
  assert.equal(e.fields[1].name, '❔ Maybe (0)');
  assert.equal(e.fields[1].value, '—');
  assert.equal(e.footer.text, 'Event #7');
  const ids = p.components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, ['evt:join:7', 'evt:maybe:7', 'evt:leave:7']);
  assert.deepEqual(p.allowedMentions, { parse: [] });
});

test('buildEventPayload: ended and cancelled events lose their buttons; a long list is cut but counted', () => {
  assert.deepEqual(buildEventPayload(row({ state: 'ended' })).components, []);
  assert.match(buildEventPayload(row({ state: 'ended' })).embeds[0].toJSON().title, /\(ended\)/);
  const cancelled = buildEventPayload(row({ state: 'cancelled' }));
  assert.deepEqual(cancelled.components, []);
  assert.match(cancelled.embeds[0].toJSON().title, /^❌ .*\(cancelled\)$/);

  const many = Array.from({ length: 40 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const e = buildEventPayload(row({ capacity: null }), { joined: many }).embeds[0].toJSON();
  assert.equal(e.fields[0].name, '✅ Going (40)');
  assert.match(e.fields[0].value, /\+15 more$/);
  assert.ok(e.fields[0].value.length <= 1024);
});

test('buildEventPayload: an image is shown in the embed', () => {
  const p = buildEventPayload(row({ image_url: 'https://example.com/a.png' }));
  assert.equal(p.embeds[0].toJSON().image.url, 'https://example.com/a.png');
});
