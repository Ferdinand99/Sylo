// Isolate one rejected item from a shared, batched platform request.
//
// The Twitch and Kick alert modules poll every server's streamers together. If the platform
// answers a batch with a 4xx because of one stored login or slug, that single value must not stop
// the poll for every other server. fetchIsolated() splits such a batch in half until the rejected
// item stands alone, and keeps the results of the rest. After the poll the rejected items are
// quarantined with a growing backoff, so the next polls leave them out.
//
// Item fault or request fault? The poll's own evidence decides. If at least one request of the
// poll succeeded, an item that is rejected on its own is at fault, however many there are. If no
// request of the poll succeeded, the request is at fault (bad credentials, a blocked address, an
// outage): nothing is quarantined and the poll fails like any other failed poll. Only the
// statuses that can mean "this value" count (400, 404, 422); 5xx, network errors, 401, 429 and the
// other 4xx fail the poll.
//
// The cost is capped: a poll makes at most `batches + EXTRA_REQUESTS` requests. When that runs
// out, the batches not yet resolved are left out of this poll (not failed); each poll quarantines
// the values it found, so the next poll resolves more.

/** Requests per poll beyond one per batch, for finding rejected items. */
export const EXTRA_REQUESTS = 120;

/** Statuses that can mean "this value was refused", as against a problem with the request. */
const VALUE_STATUSES = new Set([400, 404, 422]);

export function isRejectedStatus(status) {
  return VALUE_STATUSES.has(status);
}

/**
 * A set of items to leave out of polls for a while. Each repeated rejection doubles the wait.
 * @param {{ baseMs?: number, maxMs?: number, now?: () => number }} [o]
 */
export function createQuarantine({
  baseMs = 10 * 60_000,
  maxMs = 6 * 60 * 60_000,
  now = () => Date.now(),
} = {}) {
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
    /** How many times the item was quarantined in a row (0 when never or cleared). */
    strikes(key) {
      return entries.get(key)?.strikes ?? 0;
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
 * @param {{ quarantine: ReturnType<typeof createQuarantine>, maxRequests?: number }} o
 * @returns {Promise<{
 *   results: T[],
 *   rejected: Array<{ item: string, err: Error, waitMs: number, strikes: number }>,
 *   unresolved: Set<string>,
 * }>} `unresolved`: the items this poll knows nothing about (quarantined before, rejected now, or
 *   not reached when the request budget ran out); their stored state must be left alone.
 */
export async function fetchIsolated(items, size, fetchBatch, { quarantine, maxRequests }) {
  const results = [];
  const unresolved = new Set();
  const found = []; // rejected on their own: { item, err }
  let requests = 0;
  let succeeded = 0;
  const budget = maxRequests ?? Math.ceil(items.length / size) + EXTRA_REQUESTS;

  const run = async (batch) => {
    if (requests >= budget) {
      for (const item of batch) unresolved.add(item);
      return;
    }
    requests += 1;
    try {
      results.push(...(await fetchBatch(batch)));
    } catch (err) {
      if (!isRejectedStatus(err?.status)) throw err;
      if (batch.length === 1) {
        found.push({ item: batch[0], err });
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await run(batch.slice(0, mid));
      await run(batch.slice(mid));
      return;
    }
    succeeded += 1;
    for (const item of batch) quarantine.clear(item);
  };

  const live = items.filter((item) => {
    if (!quarantine.has(item)) return true;
    unresolved.add(item);
    return false;
  });
  for (let i = 0; i < live.length; i += size) await run(live.slice(i, i + size));

  // Nothing succeeded: the request is at fault, not the items. Quarantine nothing.
  if (found.length > 0 && succeeded === 0) throw found[0].err;

  const rejected = found.map(({ item, err }) => {
    const waitMs = quarantine.add(item);
    unresolved.add(item);
    return { item, err, waitMs, strikes: quarantine.strikes(item) };
  });
  return { results, rejected, unresolved };
}

/**
 * One log line for the values a poll just quarantined, naming the servers that saved them. Only
 * first strikes are worth a warning (a value that comes back and is rejected again is not news);
 * returns null when there is nothing new to say.
 * @param {string} label  e.g. 'Twitch logins'
 * @param {Array<{ item: string, waitMs: number, strikes: number }>} rejected
 * @param {(item: string) => string[]} savedIn  the servers that stored the value
 */
export function rejectedWarning(label, rejected, savedIn) {
  const fresh = rejected.filter((r) => r.strikes === 1);
  if (fresh.length === 0) return null;
  const shown = fresh.slice(0, 10).map((r) => `"${r.item}" (${savedIn(r.item).join(', ')})`);
  const more = fresh.length > shown.length ? ` and ${fresh.length - shown.length} more` : '';
  const mins = Math.round(Math.min(...fresh.map((r) => r.waitMs)) / 60_000);
  return `The platform rejected ${fresh.length} of the ${label} that servers saved: ${shown.join(', ')}${more}. Each is skipped for a while (first ${mins} min, longer each time it is rejected again), so the others keep working.`;
}
