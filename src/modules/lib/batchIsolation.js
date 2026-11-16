// Isolate rejected items from a shared, batched platform request.
//
// The Twitch and Kick alert modules poll every server's streamers together. If the platform
// answers a batch with a 4xx because of stored logins or slugs, those values must not stop the
// poll for every other server. fetchIsolated() works in two phases:
//  1. one request per batch. A batch that answers is done, and counts as evidence that the request
//     itself is fine. This always fits the budget, so a clean batch is never left out because
//     another one needed a long search.
//  2. only the batches that failed are halved until the rejected items stand alone. This has its
//     own budget (EXTRA_REQUESTS), spread over the failing batches in turn. When it runs out, the
//     items of the halves not reached are left out of this poll (never failed): the next poll,
//     with the found values already quarantined and the batches cut differently (the start
//     rotates), reaches them. A poll never fails because the budget ran out.
// The values found are quarantined with a growing backoff after the poll.
//
// Item fault or request fault? Only the statuses that can mean "this value" count (400, 404, 422);
// 5xx, network errors, 401, 429 and the other 4xx fail the poll. Before values are quarantined, one
// canary request is sent with a value that an earlier poll saw accepted. If the canary fails the
// same way, the platform is refusing everything (bad credentials, a blocked address, an outage,
// flapping): nothing is quarantined, and when no request of the poll succeeded the poll fails like
// any other failed poll. If no value is known to be good yet and nothing succeeded, the poll cannot
// tell: nothing is quarantined and it reports `inconclusive`.

/** Requests per poll, beyond one per batch, for finding the rejected items. */
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
  let good = null;
  let turn = 0;
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
    /** A value that the platform accepted in an earlier poll (the canary), or null. */
    get lastGood() {
      return good;
    },
    setGood(item) {
      good = item;
    },
    /** Where the next poll starts in its list of `length` items: a different place each time. */
    nextStart(length, step) {
      const start = length > 0 ? turn % length : 0;
      turn += step;
      return start;
    },
  };
}

/**
 * Run `fetchBatch` over `items` in chunks of `size`, halving the chunks the platform rejects.
 *
 * @template T
 * @param {string[]} items
 * @param {number} size
 * @param {(batch: string[]) => Promise<T[]>} fetchBatch   throws an error with `.status` on a non-OK answer
 * @param {{ quarantine: ReturnType<typeof createQuarantine>, extraRequests?: number }} o
 * @returns {Promise<{
 *   results: T[],
 *   rejected: Array<{ item: string, err: Error, waitMs: number, strikes: number }>,
 *   unresolved: Set<string>,
 *   inconclusive: boolean,
 * }>} `unresolved`: the items this poll knows nothing about (quarantined before, rejected now, or
 *   not reached when the budget ran out); their stored state must be left alone.
 */
export async function fetchIsolated(items, size, fetchBatch, { quarantine, extraRequests = EXTRA_REQUESTS }) {
  const results = [];
  const unresolved = new Set();
  const found = []; // rejected on their own: { item, err }
  const canary = quarantine.lastGood;
  let succeeded = 0;
  let lastOk = null;

  /** @returns {Promise<true | Error>} true when the platform answered; the error for a refused value */
  const ask = async (batch, keepResults = true) => {
    try {
      const got = await fetchBatch(batch);
      if (keepResults) results.push(...got);
    } catch (err) {
      if (!isRejectedStatus(err?.status)) throw err;
      return err;
    }
    if (keepResults) {
      succeeded += 1;
      lastOk = batch[0];
      for (const item of batch) quarantine.clear(item);
    }
    return true;
  };

  const live = items.filter((item) => {
    if (!quarantine.has(item)) return true;
    unresolved.add(item);
    return false;
  });
  const start = quarantine.nextStart(live.length, size);
  const order = [...live.slice(start), ...live.slice(0, start)];

  // Phase 1: one request per batch.
  const queue = [];
  for (let i = 0; i < order.length; i += size) {
    const batch = order.slice(i, i + size);
    const answer = await ask(batch);
    if (answer === true) continue;
    if (batch.length === 1) found.push({ item: batch[0], err: answer });
    else queue.push(batch);
  }

  // Phase 2: halve the failed batches, in turn, until the budget is used up.
  let spare = extraRequests;
  while (queue.length > 0) {
    const batch = queue.shift();
    const mid = Math.ceil(batch.length / 2);
    for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
      if (spare <= 0) {
        for (const item of half) unresolved.add(item);
        continue;
      }
      spare -= 1;
      const answer = await ask(half);
      if (answer === true) continue;
      if (half.length === 1) found.push({ item: half[0], err: answer });
      else queue.push(half);
    }
  }

  let inconclusive = false;
  let quarantineFound = found.length > 0;
  if (quarantineFound) {
    if (canary && !found.some((f) => f.item === canary)) {
      // Is the platform refusing everything? One request with a value that was fine before.
      const answer = await ask([canary], false);
      if (answer !== true) {
        quarantine.setGood(null); // it may have gone bad itself: pick a fresh one next time
        if (succeeded === 0) throw found[0].err;
        quarantineFound = false; // flapping: some requests answer, some are refused
      }
    } else if (succeeded === 0) {
      inconclusive = true; // nothing answered and nothing to compare with
      quarantineFound = false;
    }
  }
  if (lastOk !== null) quarantine.setGood(lastOk);

  const rejected = [];
  for (const { item, err } of found) {
    unresolved.add(item);
    if (!quarantineFound) continue;
    const waitMs = quarantine.add(item);
    rejected.push({ item, err, waitMs, strikes: quarantine.strikes(item) });
  }
  return { results, rejected, unresolved, inconclusive };
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
