// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  every,
  after,
  startSchedules,
  stopSchedules,
  scheduledCount,
  activeTimerCount,
  _resetForTests,
  STOP_GRACE_MS,
} from '../src/modules/schedule.js';
import { log } from '../src/lib/log.js';

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** Let promise callbacks (the `.finally` that clears a finished tick) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let errors;

beforeEach(() => {
  _resetForTests();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  errors = mock.method(log, 'error', () => {});
});

afterEach(() => {
  _resetForTests();
  mock.timers.reset();
  mock.restoreAll();
});

test('every only registers: nothing runs and no timer exists before startSchedules', () => {
  let calls = 0;
  every('demo', 1000, () => calls++);
  assert.equal(scheduledCount(), 1);
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(60_000);
  assert.equal(calls, 0);
});

test('the first tick comes after one interval by default', () => {
  let calls = 0;
  every('demo', 1000, () => calls++);
  startSchedules();
  mock.timers.tick(999);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  mock.timers.tick(1000);
  assert.equal(calls, 2);
});

test('firstDelayMs sets the first tick; the interval keeps its own cadence', () => {
  let calls = 0;
  every('demo', 1000, () => calls++, { firstDelayMs: 100 });
  startSchedules();
  mock.timers.tick(99);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  mock.timers.tick(900); // t = 1000: the regular interval
  assert.equal(calls, 2);
  mock.timers.tick(1000);
  assert.equal(calls, 3);
});

test('a first tick later than one interval holds the interval back', () => {
  let calls = 0;
  every('demo', 100, () => calls++, { firstDelayMs: 500 });
  startSchedules();
  mock.timers.tick(499);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  mock.timers.tick(100);
  assert.equal(calls, 2);
});

test('a tick is skipped while the previous run of the same registration is pending', async () => {
  const gate = deferred();
  let calls = 0;
  every('demo', 1000, () => {
    calls++;
    return gate.promise;
  });
  startSchedules();
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  assert.equal(calls, 1);
  gate.resolve();
  await settle();
  mock.timers.tick(1000);
  assert.equal(calls, 2);
});

test('registrations do not block each other', async () => {
  const gate = deferred();
  let a = 0;
  let b = 0;
  every('a', 1000, () => {
    a++;
    return gate.promise;
  });
  every('b', 1000, () => b++);
  startSchedules();
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  assert.equal(a, 1);
  assert.equal(b, 2);
  gate.resolve();
  await settle();
});

test('a tick that throws or rejects is logged with its module id and the schedule survives', async () => {
  let calls = 0;
  every('flaky', 1000, async () => {
    calls++;
    if (calls === 1) throw new Error('async boom');
    if (calls === 2) return Promise.reject(new Error('rejected'));
  });
  every('sync-flaky', 1000, () => {
    throw new Error('sync boom');
  });
  startSchedules();
  mock.timers.tick(1000);
  await settle();
  mock.timers.tick(1000);
  await settle();
  mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 3);
  const scopes = errors.mock.calls.map((c) => c.arguments[0]);
  assert.equal(scopes.filter((s) => s === 'module:flaky').length, 2);
  assert.equal(scopes.filter((s) => s === 'module:sync-flaky').length, 3);
  assert.ok(activeTimerCount() > 0);
});

test('stopSchedules clears every timer and no tick starts afterwards', async () => {
  let calls = 0;
  every('a', 1000, () => calls++);
  every('b', 5000, () => calls++, { firstDelayMs: 50 });
  after('c', 100, () => calls++);
  startSchedules();
  assert.ok(activeTimerCount() >= 4);
  await stopSchedules();
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(60_000);
  assert.equal(calls, 0);
});

test('stopSchedules waits for a running tick', async () => {
  const gate = deferred();
  every('slow', 1000, () => gate.promise);
  startSchedules();
  mock.timers.tick(1000);
  let stopped = false;
  const stopping = stopSchedules().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false);
  assert.equal(activeTimerCount(), 0); // the module timers are gone while the tick finishes
  gate.resolve();
  await stopping;
  assert.equal(stopped, true);
});

test('stopSchedules gives up on a stuck tick after 3 seconds', async () => {
  assert.equal(STOP_GRACE_MS, 3000);
  every('stuck', 1000, () => new Promise(() => {}));
  startSchedules();
  mock.timers.tick(1000);
  let stopped = false;
  const stopping = stopSchedules().then(() => (stopped = true));
  mock.timers.tick(2999);
  await settle();
  assert.equal(stopped, false);
  mock.timers.tick(1);
  await stopping;
  assert.equal(stopped, true);
});

test('after queues until startSchedules, then runs once', () => {
  let calls = 0;
  after('demo', 500, () => calls++);
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(calls, 0);
  startSchedules();
  assert.equal(activeTimerCount(), 1);
  mock.timers.tick(499);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(calls, 1);
});

test('after starts at once when the schedules already run', () => {
  let calls = 0;
  startSchedules();
  after('demo', 8000, () => calls++);
  assert.equal(activeTimerCount(), 1);
  mock.timers.tick(8000);
  assert.equal(calls, 1);
});

test('after can be cancelled, queued or running', () => {
  let calls = 0;
  const queued = after('demo', 100, () => calls++);
  queued.cancel();
  startSchedules();
  assert.equal(activeTimerCount(), 0);
  const live = after('demo', 100, () => calls++);
  assert.equal(activeTimerCount(), 1);
  live.cancel();
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(calls, 0);
});

test('an after callback that throws is logged and does not escape', async () => {
  startSchedules();
  after('boomer', 10, () => {
    throw new Error('nope');
  });
  after('rejecter', 10, async () => {
    throw new Error('nope too');
  });
  mock.timers.tick(10);
  await settle();
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]).sort(), ['module:boomer', 'module:rejecter']);
});

test('stopSchedules clears pending after timers and ignores later ones', async () => {
  let calls = 0;
  startSchedules();
  after('demo', 100, () => calls++);
  await stopSchedules();
  after('demo', 100, () => calls++); // a late reply during shutdown must not leave a timer behind
  assert.equal(activeTimerCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(calls, 0);
});

test('startSchedules twice is a no-op', () => {
  let calls = 0;
  every('demo', 1000, () => calls++);
  startSchedules();
  const timers = activeTimerCount();
  startSchedules();
  assert.equal(activeTimerCount(), timers);
  mock.timers.tick(1000);
  assert.equal(calls, 1);
});

test('every after startSchedules starts at once', () => {
  let calls = 0;
  startSchedules();
  every('late', 1000, () => calls++);
  assert.equal(activeTimerCount(), 1);
  mock.timers.tick(1000);
  assert.equal(calls, 1);
});
