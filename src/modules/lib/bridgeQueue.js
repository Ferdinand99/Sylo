// The send queue of the bridge: one queue per target webhook, so a busy or failing channel never slows
// another server's bridge, and messages reach the other side in the order they were written.
//
// A webhook may only be called a few times a second. Each queue spaces its sends (`minGapMs`), waits out
// a rate limit the platform reports (`retry after`), retries a transient failure with a growing pause, and
// gives up on a job after `maxAttempts`. A queue holds at most `maxQueued` jobs: when a channel is flooded
// the newest message is dropped (and counted) instead of the bridge growing without bound, and a job that
// has waited longer than `maxAgeMs` is dropped as stale instead of arriving minutes late.
//
// A delete is the exception to all three limits: a moderator's removal must reach the copy however busy the
// lane is, however long it waited, and even if the link was paused or stopped meanwhile (clear() keeps it).
//
// What a failure MEANS for the link (pause it, recreate the webhook) is the engine's decision, in
// modules/bridge.js; this file only classifies errors and decides whether to try again.

/** @typedef {'rate' | 'hook-gone' | 'message-gone' | 'forbidden' | 'bad-request' | 'transient'} FailureKind */

export class BridgeQueueError extends Error {
  /** @param {'overflow' | 'expired' | 'cleared'} reason */
  constructor(reason) {
    super(`bridge queue: ${reason}`);
    this.name = 'BridgeQueueError';
    this.reason = reason;
  }
}

const statusOf = (err, depth = 0) => {
  if (!err || typeof err !== 'object') return undefined;
  return err.status ?? err.statusCode ?? (depth < 2 ? statusOf(err.cause, depth + 1) : undefined);
};
const codeOf = (err, depth = 0) => {
  if (!err || typeof err !== 'object') return undefined;
  return err.code ?? err.rawError?.code ?? (depth < 2 ? codeOf(err.cause, depth + 1) : undefined);
};

/**
 * How long the platform said to wait, in ms. The API's own `retry_after` field is always seconds. The SDKs'
 * `retryAfter` property is not the same unit everywhere (discord.js reports milliseconds), so a small number
 * there is read as seconds and a large one as milliseconds.
 */
function retryAfterOf(err, depth = 0) {
  if (!err || typeof err !== 'object') return undefined;
  const seconds = Number(err.retry_after ?? err.data?.retry_after ?? err.rawError?.retry_after);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const n = Number(err.retryAfter);
  if (Number.isFinite(n) && n > 0) return n <= 120 ? n * 1000 : n;
  return depth < 2 ? retryAfterOf(err.cause, depth + 1) : undefined;
}

const HOOK_GONE_CODES = [10015, 'UNKNOWN_WEBHOOK', 'WEBHOOK_NOT_FOUND', 50027, 'INVALID_WEBHOOK_TOKEN'];
const MESSAGE_GONE_CODES = [10008, 'UNKNOWN_MESSAGE', 'MESSAGE_NOT_FOUND'];
const FORBIDDEN_CODES = [50001, 50013, 'MISSING_ACCESS', 'MISSING_PERMISSIONS'];

/**
 * What a failed webhook call means. `op` matters for a 404: on a send it is the webhook that is gone, on
 * an edit or a delete it is the message (someone removed the copy) unless the platform names the webhook.
 * @param {unknown} err
 * @param {'send' | 'edit' | 'delete'} [op]
 * @returns {{ kind: FailureKind, retryAfterMs?: number }}
 */
export function classifyError(err, op = 'send') {
  const status = statusOf(err);
  const code = codeOf(err);
  if (status === 429 || code === 'RATE_LIMITED' || err?.name === 'RateLimitError') {
    return { kind: 'rate', retryAfterMs: Math.min(60_000, Math.max(250, retryAfterOf(err) ?? 2000)) };
  }
  if (HOOK_GONE_CODES.includes(code) || status === 401) return { kind: 'hook-gone' };
  if (MESSAGE_GONE_CODES.includes(code)) return { kind: 'message-gone' };
  if (status === 404) return { kind: op === 'send' ? 'hook-gone' : 'message-gone' };
  if (status === 403 || FORBIDDEN_CODES.includes(code)) return { kind: 'forbidden' };
  if (status === 400 || status === 413 || status === 422) return { kind: 'bad-request' };
  return { kind: 'transient' };
}

/**
 * How long to wait between two calls to one webhook, by the platform that owns it. Fluxer publishes its limits:
 * 60 sends, 30 edits and 30 deletes per webhook per minute, so a send is spaced 1 s apart and an edit or a delete
 * 2 s apart (a little more than the exact figure). Discord does not publish webhook figures and reports them in
 * its answers (a send is commonly 5 per 2 s per webhook), so it is spaced 450 ms apart and a "retry after" from
 * the platform is still waited out. A bridged channel has one webhook of Sylo's on each side (a platform allows
 * 15 per channel, Fluxer 1000 per server), so a server's links never share a webhook, and so never a queue.
 * @param {'discord' | 'fluxer'} platform
 * @param {'send' | 'edit' | 'delete'} [op]
 */
export function relayGapMs(platform, op = 'send') {
  if (platform === 'fluxer') return op === 'send' ? 1050 : 2050;
  return 450;
}

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * @param {{ minGapMs?: number, maxQueued?: number, maxAgeMs?: number, maxAttempts?: number,
 *   platformGaps?: boolean (space each call by the `gapMs` it was queued with, see relayGapMs, instead of `minGapMs`),
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts]
 */
export function createRelayQueue({
  minGapMs = 350,
  maxQueued = 100,
  maxAgeMs = 5 * 60_000,
  maxAttempts = 4,
  platformGaps = false,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { tasks: any[], running: boolean, dropped: number }>} */
  const lanes = new Map();

  const gapOf = (task) => (platformGaps && task.gapMs != null ? task.gapMs : minGapMs);

  async function drain(key, lane) {
    lane.running = true;
    try {
      while (lane.tasks.length) {
        const task = lane.tasks[0];
        if (!task.keep && now() - task.at > maxAgeMs) {
          lane.tasks.shift();
          lane.dropped += 1;
          task.reject(new BridgeQueueError('expired'));
          continue;
        }
        try {
          const value = await task.run();
          lane.tasks.shift();
          task.resolve(value);
        } catch (err) {
          const failure = classifyError(err, task.op);
          if ((failure.kind === 'rate' || failure.kind === 'transient') && task.attempts < maxAttempts - 1) {
            task.attempts += 1;
            await sleep(failure.kind === 'rate' ? failure.retryAfterMs : 1000 * 2 ** (task.attempts - 1));
            continue;
          }
          lane.tasks.shift();
          task.reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { failure }));
        }
        if (lane.tasks.length) await sleep(Math.max(gapOf(task), gapOf(lane.tasks[0])));
      }
    } finally {
      lane.running = false;
      if (!lane.tasks.length) lanes.delete(key);
    }
  }

  return {
    /**
     * Queue a job for a target webhook. The returned promise settles when the job has run (or been dropped).
     * @template T
     * @param {string} key  the target webhook (one lane per webhook)
     * @param {() => Promise<T>} run
     * @param {{ op?: 'send' | 'edit' | 'delete', gapMs?: number }} [opts]  `gapMs`: the pause this call needs
     *   from its neighbours on the webhook (see relayGapMs); the queue's own `minGapMs` when not given
     * @returns {Promise<T>}
     */
    enqueue(key, run, { op = 'send', gapMs } = {}) {
      let lane = lanes.get(key);
      if (!lane) {
        lane = { tasks: [], running: false, dropped: 0 };
        lanes.set(key, lane);
      }
      if (op !== 'delete' && lane.tasks.length >= maxQueued) {
        lane.dropped += 1;
        return Promise.reject(new BridgeQueueError('overflow'));
      }
      const result = new Promise((resolve, reject) => {
        lane.tasks.push({ run, op, gapMs, keep: op === 'delete', at: now(), attempts: 0, resolve, reject });
      });
      if (!lane.running) void drain(key, lane);
      return result;
    },
    /** How many jobs wait for a webhook, and how many were dropped since the lane was last empty. */
    stats(key) {
      const lane = lanes.get(key);
      return { queued: lane?.tasks.length ?? 0, dropped: lane?.dropped ?? 0 };
    },
    /** Drop everything waiting for a webhook (the link was paused, unlinked or failed). */
    clear(key) {
      const lane = lanes.get(key);
      if (!lane) return 0;
      // The job at the head may be running, and a delete is never dropped: leave those, drop the rest.
      const dropped = lane.tasks.filter((t, i) => !t.keep && !(lane.running && i === 0));
      lane.tasks = lane.tasks.filter((t) => !dropped.includes(t));
      for (const t of dropped) t.reject(new BridgeQueueError('cleared'));
      return dropped.length;
    },
    /** How many webhooks have a queue right now (for tests and the health page). */
    lanes: () => lanes.size,
  };
}
