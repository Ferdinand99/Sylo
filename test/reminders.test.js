import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReminder,
  updateReminder,
  getScheduled,
  listScheduled,
  dueScheduled,
  advanceReminder,
  markSingleFired,
  setScheduledEnabled,
} from '../src/db/scheduledMessages.js';

const G = 'a00000000000000001';

test('createReminder + hydrate: parses spec, splits days, sets next_run for recurring', () => {
  const id = createReminder(G, {
    name: 'Standup',
    channelId: '111111111111111111',
    spec: { content: 'stand up', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 60,
    days: [1, 2, 3, 4, 5],
  });
  const r = getScheduled(G, Number(id));
  assert.equal(r.name, 'Standup');
  assert.equal(r.mode, 'multiple');
  assert.deepEqual(r.dayList, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.spec, { content: 'stand up', embeds: [] });
  assert.ok(r.next_run_at > Date.now());
  assert.equal(r.run_at, null);
});

test('single reminder stores run_at and no next_run_at', () => {
  const when = Date.now() + 3_600_000;
  const id = createReminder(G, {
    name: 'One-off',
    channelId: '111111111111111111',
    spec: { content: 'once', embeds: [] },
    mode: 'single',
    intervalMinutes: 60,
    runAt: when,
  });
  const r = getScheduled(G, Number(id));
  assert.equal(r.mode, 'single');
  assert.equal(r.run_at, when);
});

test('dueScheduled: recurring due by next_run_at, single due by run_at', () => {
  const past = Date.now() - 1000;
  const a = createReminder(G, { name: 'A', channelId: '1'.repeat(18), spec: { content: 'a', embeds: [] }, mode: 'single', intervalMinutes: 60, runAt: past });
  // recurring far in the future — not due
  const b = createReminder(G, { name: 'B', channelId: '1'.repeat(18), spec: { content: 'b', embeds: [] }, mode: 'multiple', intervalMinutes: 60, days: [0,1,2,3,4,5,6] });

  const due = dueScheduled(Date.now()).map((r) => r.id);
  assert.ok(due.includes(Number(a)));
  assert.ok(!due.includes(Number(b)));

  // make b due by yanking next_run_at back
  advanceReminder(Number(b), -1, Date.now() - 120_000); // next_run_at = now - 2min - 1min
  assert.ok(dueScheduled(Date.now()).map((r) => r.id).includes(Number(b)));
});

test('markSingleFired disables the row; advanceReminder pushes next_run_at forward', () => {
  const id = Number(createReminder(G, { name: 'C', channelId: '1'.repeat(18), spec: { content: 'c', embeds: [] }, mode: 'multiple', intervalMinutes: 30, days: [0,1,2,3,4,5,6] }));
  const before = getScheduled(G, id).next_run_at;
  advanceReminder(id, 30, Date.now());
  assert.ok(getScheduled(G, id).next_run_at > before || getScheduled(G, id).next_run_at >= Date.now());

  const sid = Number(createReminder(G, { name: 'D', channelId: '1'.repeat(18), spec: { content: 'd', embeds: [] }, mode: 'single', intervalMinutes: 60, runAt: Date.now() - 1 }));
  markSingleFired(sid, Date.now());
  assert.equal(getScheduled(G, sid).enabled, 0);
  assert.ok(!dueScheduled(Date.now()).map((r) => r.id).includes(sid));
});

test('updateReminder rewrites the row; legacy rows without spec hydrate from content', () => {
  const id = Number(createReminder(G, { name: 'E', channelId: '1'.repeat(18), spec: { content: 'old', embeds: [] }, mode: 'multiple', intervalMinutes: 60, days: [1] }));
  updateReminder(G, id, { name: 'E2', channelId: '2'.repeat(18), spec: { content: 'new', embeds: [] }, mode: 'multiple', intervalMinutes: 120, days: [6] });
  const r = getScheduled(G, id);
  assert.equal(r.name, 'E2');
  assert.equal(r.channel_id, '2'.repeat(18));
  assert.equal(r.interval_minutes, 120);
  assert.deepEqual(r.dayList, [6]);
  assert.equal(r.spec.content, 'new');

  assert.ok(listScheduled(G).length >= 1);
  setScheduledEnabled(G, id, false);
  assert.equal(getScheduled(G, id).enabled, 0);
});
