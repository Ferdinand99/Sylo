// Reminder ticks must not overlap, and a due reminder must be posted once even when two ticks hold
// the same due row: a slow batch in one server used to make later ticks post other servers'
// reminders (and their pings) again.
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import {
  createReminder,
  dueScheduled,
  listScheduled,
  advanceReminder,
  markSingleFired,
} from '../src/db/scheduledMessages.js';
import { _tick } from '../src/modules/scheduledMessages.js';
import { scheduledCount, startSchedules, stopSchedules } from '../src/modules/schedule.js';

const G = '900000000000000081';
const CH = '700000000000000811';
const sleepTurn = () => new Promise((r) => setImmediate(r));

function fakeClient(sends, gate) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sends.push(payload);
      await gate.promise; // a slow send, as when the channel's rate limit holds it
      return { id: `m${sends.length}` };
    },
  };
  const client = {
    readyChecks: 0,
    isReady() {
      this.readyChecks += 1;
      return true;
    },
    guilds: { cache: new Map() },
  };
  client.guilds.cache.set(G, {
    id: G,
    client,
    channels: { cache: new Map([[CH, channel]]) },
    members: { me: null },
  });
  return client;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function dueSingle(content) {
  await createReminder(G, {
    name: content,
    channelId: CH,
    spec: { content, embeds: [] },
    mode: 'single',
    runAt: Date.now() - 1000,
  });
}

test('claiming a due row works once: the second claimer gets false', async () => {
  await dueSingle('claim me');
  const [row] = await dueScheduled();
  assert.equal(await markSingleFired(row.id, Date.now(), row.run_at), true);
  assert.equal(await markSingleFired(row.id, Date.now(), row.run_at), false);

  await createReminder(G, {
    name: 'every minute',
    channelId: CH,
    spec: { content: 'rec', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 1,
  });
  const rec = (await listScheduled(G)).find((r) => r.name === 'every minute');
  const dueNow = rec.next_run_at; // pretend the occurrence is due now
  assert.equal(await advanceReminder(rec.id, 1, dueNow, rec.next_run_at), true);
  assert.equal(await advanceReminder(rec.id, 1, dueNow, rec.next_run_at), false, 'that occurrence is taken');
});

test('two overlapping ticks post a due reminder once', async () => {
  await setGuildModule(G, 'reminders', { enabled: true, config: { allowPings: false } });
  const sends = [];
  const gate = deferred();
  runtime.clients.discord = fakeClient(sends, gate);
  await dueSingle('only once');

  // Both read the due list before either has claimed the row.
  const first = _tick();
  const second = _tick();
  for (let i = 0; i < 20; i += 1) await sleepTurn();
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(sends.filter((p) => p.content === 'only once').length, 1);
  runtime.clients.discord = null;
});

test('the scheduler does not start a reminders tick while the previous one is still running', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const sends = [];
  const gate = deferred();
  const client = fakeClient(sends, gate);
  runtime.clients.discord = client;
  try {
    await dueSingle('slow batch');
    assert.ok(scheduledCount() >= 1);
    startSchedules();
    mock.timers.tick(20_000);
    for (let i = 0; i < 200 && sends.length === 0; i += 1) await sleepTurn();
    assert.equal(sends.length, 1, 'the first tick is now waiting on its send');
    const checks = client.readyChecks;
    mock.timers.tick(20_000); // the next interval fires while the first tick is still running
    mock.timers.tick(20_000);
    await sleepTurn();
    assert.equal(client.readyChecks, checks, 'no second tick started');
  } finally {
    gate.resolve();
    await stopSchedules();
    mock.timers.reset();
    runtime.clients.discord = null;
  }
});
