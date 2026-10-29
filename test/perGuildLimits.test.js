// Things a server admin can create one by one (reminders, cleanup schedules, GitHub watches,
// saved messages) have a per-server ceiling, so a script cannot grow the database without end.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LimitError, LIMITS } from '../src/lib/limits.js';
import { createReminder } from '../src/db/scheduledMessages.js';
import { createCleanupSchedule } from '../src/db/channelCleanup.js';
import { createGithubWatch } from '../src/db/githubWatches.js';
import { createComposed } from '../src/db/composedMessages.js';
import { createEvent } from '../src/db/events.js';

const CH = '100000000000000001';

async function fill(n, make) {
  for (let i = 0; i < n; i++) await make(i);
}

test('reminders stop at the limit', async () => {
  const G = '900000000000000901';
  const make = () =>
    createReminder(G, {
      name: 'r',
      channelId: CH,
      spec: { content: 'x' },
      mode: 'multiple',
      days: [],
      intervalMinutes: 60,
    });
  await fill(LIMITS.reminders, make);
  await assert.rejects(make(), LimitError);
});

test('cleanup schedules stop at the limit', async () => {
  const G = '900000000000000902';
  const make = () =>
    createCleanupSchedule(G, { channelId: CH, days: [1], timeHhmm: '03:00', maxAgeHours: 24 });
  await fill(LIMITS.cleanupSchedules, make);
  await assert.rejects(make(), LimitError);
});

test('GitHub watches stop at the limit', async () => {
  const G = '900000000000000903';
  const make = (i) => createGithubWatch(G, { repo: `o/r${i ?? 'x'}`, channelId: CH, events: ['push'] });
  await fill(LIMITS.githubWatches, make);
  await assert.rejects(make(), LimitError);
});

test('saved messages stop at the limit', async () => {
  const G = '900000000000000904';
  const make = () => createComposed(G, { name: 'm', channelId: CH, spec: { content: 'x' } });
  await fill(LIMITS.composedMessages, make);
  await assert.rejects(make(), LimitError);
});

test('events: 50 upcoming per server, 500 sign-ups per event', () => {
  assert.equal(LIMITS.events, 50);
  assert.equal(LIMITS.eventParticipants, 500);
});

test('createEvent in the module stops at the upcoming-events limit', async () => {
  const { createEvent: post } = await import('../src/modules/events.js');
  const { parseEventInput } = await import('../src/modules/events.js');
  const G = '900000000000000905';
  const ch = { id: CH, isTextBased: () => true, send: async () => ({ id: '1' }) };
  const guild = { id: G, channels: { cache: new Map([[CH, ch]]) }, roles: { cache: new Map() } };
  const input = parseEventInput({ title: 'x', start: '2999-01-01 10:00' }).value;
  for (let i = 0; i < LIMITS.events; i++)
    await createEvent({ guildId: G, channelId: CH, title: 'x', startAt: input.startAt, hostId: 'h' });
  await assert.rejects(post({ guild, hostId: 'h', channelId: CH, input }), LimitError);
});

test('quote board: 10 000 quotes per server', () => {
  assert.equal(LIMITS.quotes, 10_000);
});

test('temporary roles: 2000 active per server', () => {
  assert.equal(LIMITS.tempRoles, 2000);
});

test('suggestions: 5000 stored per server, 10 open per member', () => {
  assert.equal(LIMITS.suggestions, 5000);
  assert.equal(LIMITS.openSuggestionsPerMember, 10);
});
