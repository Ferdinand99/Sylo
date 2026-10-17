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
