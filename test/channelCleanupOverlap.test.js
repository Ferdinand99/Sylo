// A channel cleanup can take longer than the 5-minute tick (history fetches, bulk and single
// deletes). The schedule is only marked done at the end, so a second tick started meanwhile used to
// pick the same schedule and clean the same channel again.
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { createCleanupSchedule } from '../src/db/channelCleanup.js';
import { startSchedules, stopSchedules } from '../src/modules/schedule.js';
import '../src/modules/channelCleanup.js';

const G = '900000000000000091';
const CH = '700000000000000911';
const sleepTurn = () => new Promise((r) => setImmediate(r));

test('the scheduler does not start a channel-cleanup tick while the previous one is still running', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let release;
  const gate = new Promise((r) => (release = r));
  let fetches = 0;
  const channel = {
    name: 'general',
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        fetches += 1;
        await gate; // a long history walk
        return new Map();
      },
    },
  };
  const client = { isReady: () => true, guilds: { cache: new Map() } };
  client.guilds.cache.set(G, {
    id: G,
    name: 'Test',
    client,
    members: { me: {} },
    channels: { cache: new Map([[CH, channel]]) },
  });
  runtime.clients.discord = client;
  try {
    await setGuildModule(G, 'channel-cleanup', { enabled: true, config: {} });
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await createCleanupSchedule(G, {
      channelId: CH,
      days: [],
      timeHhmm: hhmm,
      maxAgeHours: 24,
      skipPinned: false,
    });

    startSchedules();
    mock.timers.tick(5 * 60_000);
    for (let i = 0; i < 200 && fetches === 0; i += 1) await sleepTurn();
    assert.equal(fetches, 1, 'the first tick is cleaning the channel');

    mock.timers.tick(5 * 60_000); // the next interval fires while the first tick is still running
    mock.timers.tick(5 * 60_000);
    for (let i = 0; i < 20; i += 1) await sleepTurn();
    assert.equal(fetches, 1, 'the same channel is not cleaned a second time at once');
  } finally {
    release();
    await stopSchedules();
    mock.timers.reset();
    runtime.clients.discord = null;
  }
});
