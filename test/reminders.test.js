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

test('createReminder + hydrate: parses spec, splits days, sets next_run for recurring', async () => {
  const id = await createReminder(G, {
    name: 'Standup',
    channelId: '111111111111111111',
    spec: { content: 'stand up', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 60,
    days: [1, 2, 3, 4, 5],
  });
  const r = await getScheduled(G, Number(id));
  assert.equal(r.name, 'Standup');
  assert.equal(r.mode, 'multiple');
  assert.deepEqual(r.dayList, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.spec, { content: 'stand up', embeds: [] });
  assert.ok(r.next_run_at > Date.now());
  assert.equal(r.run_at, null);
});

test('single reminder stores run_at and no next_run_at', async () => {
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
  assert.equal(r.mode, 'single');
  assert.equal(r.run_at, when);
});

test('dueScheduled: recurring due by next_run_at, single due by run_at', async () => {
  const past = Date.now() - 1000;
  const a = await createReminder(G, {
    name: 'A',
    channelId: '1'.repeat(18),
    spec: { content: 'a', embeds: [] },
    mode: 'single',
    intervalMinutes: 60,
    runAt: past,
  });
  // recurring far in the future — not due
  const b = await createReminder(G, {
    name: 'B',
    channelId: '1'.repeat(18),
    spec: { content: 'b', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 60,
    days: [0, 1, 2, 3, 4, 5, 6],
  });

  const due = (await dueScheduled(Date.now())).map((r) => r.id);
  assert.ok(due.includes(Number(a)));
  assert.ok(!due.includes(Number(b)));

  // make b due by yanking next_run_at back
  await advanceReminder(Number(b), -1, Date.now() - 120_000); // next_run_at = now - 2min - 1min
  assert.ok((await dueScheduled(Date.now())).map((r) => r.id).includes(Number(b)));
});

test('markSingleFired disables the row; advanceReminder pushes next_run_at forward', async () => {
  const id = Number(
    await createReminder(G, {
      name: 'C',
      channelId: '1'.repeat(18),
      spec: { content: 'c', embeds: [] },
      mode: 'multiple',
      intervalMinutes: 30,
      days: [0, 1, 2, 3, 4, 5, 6],
    })
  );
  const before = (await getScheduled(G, id)).next_run_at;
  await advanceReminder(id, 30, Date.now());
  const after = (await getScheduled(G, id)).next_run_at;
  assert.ok(after > before || after >= Date.now());

  const sid = Number(
    await createReminder(G, {
      name: 'D',
      channelId: '1'.repeat(18),
      spec: { content: 'd', embeds: [] },
      mode: 'single',
      intervalMinutes: 60,
      runAt: Date.now() - 1,
    })
  );
  await markSingleFired(sid, Date.now());
  assert.equal((await getScheduled(G, sid)).enabled, 0);
  assert.ok(!(await dueScheduled(Date.now())).map((r) => r.id).includes(sid));
});

test('updateReminder rewrites the row; legacy rows without spec hydrate from content', async () => {
  const id = Number(
    await createReminder(G, {
      name: 'E',
      channelId: '1'.repeat(18),
      spec: { content: 'old', embeds: [] },
      mode: 'multiple',
      intervalMinutes: 60,
      days: [1],
    })
  );
  await updateReminder(G, id, {
    name: 'E2',
    channelId: '2'.repeat(18),
    spec: { content: 'new', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 120,
    days: [6],
  });
  const r = await getScheduled(G, id);
  assert.equal(r.name, 'E2');
  assert.equal(r.channel_id, '2'.repeat(18));
  assert.equal(r.interval_minutes, 120);
  assert.deepEqual(r.dayList, [6]);
  assert.equal(r.spec.content, 'new');

  assert.ok((await listScheduled(G)).length >= 1);
  await setScheduledEnabled(G, id, false);
  assert.equal((await getScheduled(G, id)).enabled, 0);
});
