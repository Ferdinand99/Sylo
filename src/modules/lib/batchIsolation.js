// Isolate one rejected item from a shared, batched platform request.
//
// The Twitch and Kick alert modules poll every server's streamers together. If the platform
// answers a batch with a 4xx because of one stored login or slug, that single value must not stop
// the poll for every other server. fetchIsolated() splits such a batch in half until the rejected
// item stands alone, quarantines that item with a growing backoff, and keeps the results of the
// rest. Other failures (5xx, network errors, 401, 429) still throw: they are not about one item
// and retrying the whole poll later is right.

/** More rejected items than this in one poll means the request is at fault, not the items. */
const MAX_REJECTED = 10;

/** Status codes that mean "the platform rejected the request itself", not "try again later". */
export function isRejectedStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 401 && status !== 429;
}

/**
 * A set of items to leave out of polls for a while. Each repeated rejection doubles the wait.
 * @param {{ baseMs?: number, maxMs?: number, now?: () => number }} [o]
 */
export function createQuarantine({ baseMs = 10 * 60_000, maxMs = 6 * 60 * 60_000, now = Date.now } = {}) {
  /** @type {Map<string, { until: number, strikes: number }>} */
  const entries = new Map();
  return {
    /** True while the item is waiting out its backoff. */
    has(key) {
      const e = entries.get(key);
      return Boolean(e && e.until > now());
    },
    /** Quarantine the item (again); returns the wait in ms. */
    add(key) {
      const strikes = (entries.get(key)?.strikes ?? 0) + 1;
      const wait = Math.min(maxMs, baseMs * 2 ** (strikes - 1));
      entries.set(key, { until: now() + wait, strikes });
      return wait;
    },
    /** Forget an item that the platform accepted again. */
    clear(key) {
      entries.delete(key);
    },
    /** Drop entries that are over and no longer stored anywhere (keeps the map small). */
    prune(keep) {
      for (const [key, e] of entries) if (e.until <= now() && !keep.has(key)) entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Run `fetchBatch` over `items` in chunks of `size`, bisecting any chunk the platform rejects.
 *
 * @template T
 * @param {string[]} items
 * @param {number} size
 * @param {(batch: string[]) => Promise<T[]>} fetchBatch   throws an error with `.status` on a non-OK answer
 * @param {{ quarantine: ReturnType<typeof createQuarantine>, onRejected?: (item: string, err: Error, waitMs: number) => void, maxRejected?: number }} o
 * @returns {Promise<T[]>} the results of every accepted item
 */
export async function fetchIsolated(
  items,
  size,
  fetchBatch,
  { quarantine, onRejected, maxRejected = MAX_REJECTED }
) {
  const out = [];
  const added = [];
  const run = async (batch) => {
    try {
      out.push(...(await fetchBatch(batch)));
    } catch (err) {
      if (!isRejectedStatus(err?.status)) throw err;
      if (batch.length === 1) {
        // Many different items rejected in one poll: the problem is the request (a bad app
        // credential, say), not the items. Undo and fail the poll like any other error.
        if (added.length >= maxRejected) {
          for (const item of added) quarantine.clear(item);
          throw err;
        }
        added.push(batch[0]);
        const waitMs = quarantine.add(batch[0]);
        onRejected?.(batch[0], err, waitMs);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await run(batch.slice(0, mid));
      await run(batch.slice(mid));
      return;
    }
    for (const item of batch) quarantine.clear(item);
  };
  const live = items.filter((item) => !quarantine.has(item));
  for (let i = 0; i < live.length; i += size) await run(live.slice(i, i + size));
  return out;
}
