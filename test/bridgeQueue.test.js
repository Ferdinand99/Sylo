// The bridge's send queue: one lane per webhook, in order, spaced, with back-off on a rate limit, a cap on
// what waits and a limit on how long a job may wait; and how a failed webhook call is classified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeQueueError, classifyError, createRelayQueue } from '../src/modules/lib/bridgeQueue.js';

const err = (props) => Object.assign(new Error('x'), props);

test('a failed webhook call is classified by what it means for the link', () => {
  assert.deepEqual(classifyError(err({ status: 429, retryAfter: 2 })), { kind: 'rate', retryAfterMs: 2000 });
  assert.deepEqual(classifyError(err({ statusCode: 429, retry_after: 0.5 })), {
    kind: 'rate',
    retryAfterMs: 500,
  });
  assert.deepEqual(
    classifyError(err({ status: 429, retryAfter: 3500 })),
    { kind: 'rate', retryAfterMs: 3500 },
    'milliseconds'
  );
  assert.deepEqual(
    classifyError(err({ status: 429 })),
    { kind: 'rate', retryAfterMs: 2000 },
    'no hint: two seconds'
  );
  assert.equal(classifyError(err({ status: 429, retryAfter: 9999 })).retryAfterMs, 9999);
  assert.equal(
    classifyError(err({ status: 429, retryAfter: 600000 })).retryAfterMs,
    60000,
    'never longer than a minute'
  );
  assert.equal(
    classifyError(err({ status: 429, retryAfter: 0.001 })).retryAfterMs,
    250,
    'never shorter than 250 ms'
  );
  assert.deepEqual(
    classifyError(err({ cause: err({ statusCode: 429, retry_after: 1 }) })),
    { kind: 'rate', retryAfterMs: 1000 },
    'the SDKs wrap the HTTP error in a cause'
  );

  assert.equal(classifyError(err({ code: 10015, status: 404 })).kind, 'hook-gone', 'Unknown Webhook');
  assert.equal(classifyError(err({ code: 'UNKNOWN_WEBHOOK' })).kind, 'hook-gone');
  assert.equal(classifyError(err({ status: 401 })).kind, 'hook-gone', 'a bad webhook token');
  assert.equal(classifyError(err({ status: 404 }), 'send').kind, 'hook-gone');
  assert.equal(classifyError(err({ status: 404 }), 'edit').kind, 'message-gone');
  assert.equal(classifyError(err({ status: 404 }), 'delete').kind, 'message-gone');
  assert.equal(classifyError(err({ code: 10008, status: 404 }), 'edit').kind, 'message-gone');
  assert.equal(classifyError(err({ status: 403 })).kind, 'forbidden');
  assert.equal(classifyError(err({ code: 50013 })).kind, 'forbidden');
  assert.equal(classifyError(err({ status: 400 })).kind, 'bad-request');
  assert.equal(classifyError(err({ status: 413 })).kind, 'bad-request');
  assert.equal(classifyError(err({ status: 500 })).kind, 'transient');
  assert.equal(classifyError(new Error('ECONNRESET')).kind, 'transient');
  assert.equal(classifyError('a string').kind, 'transient');
  assert.equal(classifyError(null).kind, 'transient');
});

function harness(opts = {}) {
  const sleeps = [];
  let clock = 1_000_000;
  const queue = createRelayQueue({
    minGapMs: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...opts,
  });
  return { queue, sleeps, tick: (ms) => (clock += ms) };
}

test('jobs of one webhook run one at a time, in the order they came, spaced apart', async () => {
  const { queue, sleeps } = harness();
  const order = [];
  let running = 0;
  let peak = 0;
  const job = (name) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setImmediate(r));
    order.push(name);
    running -= 1;
    return name;
  };
  const results = await Promise.all(['a', 'b', 'c'].map((n) => queue.enqueue('hook1', job(n))));
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(peak, 1);
  assert.deepEqual(sleeps, [100, 100], 'a gap after each job that has another behind it');
  assert.equal(queue.lanes(), 0, 'an idle lane is forgotten');
});

test('webhooks do not wait for each other', async () => {
  const { queue } = harness();
  const gate = {};
  gate.open = new Promise((r) => (gate.release = r));
  const slow = queue.enqueue('slow', () => gate.open.then(() => 'slow done'));
  const fast = await queue.enqueue('fast', async () => 'fast done');
  assert.equal(fast, 'fast done', 'the second webhook finished while the first was stuck');
  gate.release();
  assert.equal(await slow, 'slow done');
});

test('a rate limit is waited out as long as the platform said, then the same job runs again', async () => {
  const { queue, sleeps } = harness();
  let calls = 0;
  const out = await queue.enqueue('h', async () => {
    calls += 1;
    if (calls === 1) throw err({ status: 429, retryAfter: 1.25 });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1250]);
});

test('a transient failure backs off 1 s, 2 s, 4 s and gives up after four tries', async () => {
  const { queue, sleeps } = harness();
  let calls = 0;
  await assert.rejects(
    queue.enqueue('h', async () => {
      calls += 1;
      throw err({ status: 503 });
    }),
    (e) => e.failure.kind === 'transient' && e.status === 503
  );
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  const again = harness();
  let n = 0;
  assert.equal(
    await again.queue.enqueue('h', async () => (++n < 3 ? Promise.reject(err({ status: 500 })) : 'fine')),
    'fine'
  );
  assert.deepEqual(again.sleeps, [1000, 2000]);
});

test('a refusal is not retried: forbidden, webhook gone and bad request fail at once, with their kind', async () => {
  for (const [props, kind] of [
    [{ status: 403 }, 'forbidden'],
    [{ status: 404, code: 10015 }, 'hook-gone'],
    [{ status: 400 }, 'bad-request'],
  ]) {
    const { queue, sleeps } = harness();
    let calls = 0;
    await assert.rejects(
      queue.enqueue('h', async () => {
        calls += 1;
        throw err(props);
      }),
      (e) => e.failure.kind === kind
    );
    assert.equal(calls, 1, kind);
    assert.deepEqual(sleeps, []);
  }
});

test('a failed job does not stop the ones behind it', async () => {
  const { queue } = harness();
  const bad = queue.enqueue('h', async () => {
    throw err({ status: 403 });
  });
  const good = queue.enqueue('h', async () => 'next');
  await assert.rejects(bad);
  assert.equal(await good, 'next');
});

test('a full lane drops the newest job and counts it; the jobs already in keep their place', async () => {
  const { queue } = harness({ maxQueued: 2 });
  const gate = {};
  gate.open = new Promise((r) => (gate.release = r));
  const first = queue.enqueue('h', () => gate.open.then(() => 1));
  const second = queue.enqueue('h', async () => 2);
  const third = queue.enqueue('h', async () => 3);
  await assert.rejects(third, (e) => e instanceof BridgeQueueError && e.reason === 'overflow');
  assert.deepEqual(queue.stats('h'), { queued: 2, dropped: 1 });
  assert.deepEqual(queue.stats('other'), { queued: 0, dropped: 0 }, 'another webhook has its own lane');
  gate.release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test('a job that waited too long is dropped instead of arriving late', async () => {
  const { queue, tick } = harness({ maxAgeMs: 60_000 });
  const gate = {};
  gate.open = new Promise((r) => (gate.release = r));
  const first = queue.enqueue('h', () => gate.open.then(() => 'first'));
  const stale = queue.enqueue('h', async () => 'stale');
  const expired = assert.rejects(stale, (e) => e instanceof BridgeQueueError && e.reason === 'expired');
  tick(61_000);
  gate.release();
  assert.equal(await first, 'first');
  await expired;
});

test('clearing a lane drops what waits (a paused or unlinked bridge) but lets the running job finish', async () => {
  const { queue } = harness();
  const gate = {};
  gate.open = new Promise((r) => (gate.release = r));
  const running = queue.enqueue('h', () => gate.open.then(() => 'ran'));
  const waiting = queue.enqueue('h', async () => 'never');
  assert.equal(queue.clear('h'), 1);
  await assert.rejects(waiting, (e) => e.reason === 'cleared');
  gate.release();
  assert.equal(await running, 'ran');
  assert.equal(queue.clear('nothing'), 0);
});
