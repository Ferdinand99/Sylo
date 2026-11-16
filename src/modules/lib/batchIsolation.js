// Isolate rejected items from a shared, batched platform request.
//
// The Twitch and Kick alert modules poll every server's streamers together. If the platform
// answers a batch with a 4xx because of stored logins or slugs, those values must not stop the
// poll for every other server. fetchIsolated() works in two phases:
//  1. one request per batch. A batch that answers is done, and counts as evidence that the request
//     itself is fine. This always fits the budget, so a clean batch is never left out because
//     another one needed a long search. Batches are cut in this order: the values of groups (servers)
//     not known to save rejected values, in one pool; then the suspects (see below) of those
//     groups; then, for each flagged group, its own values on their own. If no batch answered, one
//     canary request (below) is sent before phase 2, and a refused canary fails the poll at once.
//  2. only the batches that failed are halved until the rejected items stand alone. This has its
//     own budget (EXTRA_REQUESTS) and goes depth first: one failed batch is searched down to single
//     values before the next is started, so every poll isolates (and so quarantines) values, however
//     many there are. Failed batches are searched in the order they were cut, so the pool's failures
//     come before the suspects' and the flagged groups'. When the budget runs out, the items of the
//     chunks not reached are left out of this poll (never failed) and remembered as suspects: the
//     next poll batches them after the clean values, so the clean ones are always fetched. A poll
//     never fails because the budget ran out.
//  A group (the server that saved a value, `groupOf`) is flagged when one of its values was found
//  rejected, for FLAG_TTL_MS after the last time. Its values are never batched with other groups'
//  values again while flagged, so a server that keeps saving fresh rejected values (150 a poll)
//  cannot keep other servers' values unresolved. Not every group is batched apart all the time
//  because that would cost one request per server per poll, however small.
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

/** How long a group stays flagged after one of its values was last found rejected. */
export const FLAG_TTL_MS = 2 * 60 * 60_000;

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
  /** @type {Set<string>} */
  let suspects = new Set();
  /** @type {Map<string, number>} group -> when its flag runs out */
  const flagged = new Map();
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
    /** Flag a group (a server that saved a rejected value) for FLAG_TTL_MS from now. */
    flag(group) {
      flagged.set(group, now() + FLAG_TTL_MS);
    },
    isFlagged(group) {
      const until = flagged.get(group);
      if (until === undefined) return false;
      if (until <= now()) {
        flagged.delete(group);
        return false;
      }
      return true;
    },
    /** Values left unchecked inside a failed chunk when the last poll ran out of budget. */
    get suspects() {
      return suspects;
    },
    setSuspects(items) {
      suspects = new Set(items);
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
 * @param {{ quarantine: ReturnType<typeof createQuarantine>, extraRequests?: number, groupOf?: (item: string) => string | null }} o
 * @returns {Promise<{
 *   results: T[],
 *   rejected: Array<{ item: string, err: Error, waitMs: number, strikes: number }>,
 *   unresolved: Set<string>,
 *   inconclusive: boolean,
 *   skipped: number,
 * }>} `skipped`: how many items were left out only because the budget ran out. `unresolved`: the items this poll knows nothing about (quarantined before, rejected now, or
 *   not reached when the budget ran out); their stored state must be left alone.
 */
export async function fetchIsolated(
  items,
  size,
  fetchBatch,
  { quarantine, extraRequests = EXTRA_REQUESTS, groupOf = () => null }
) {
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
  // Cut the batches: the pool of unflagged groups first, then its suspects (values left unchecked
  // in a failed chunk by an earlier poll), then each flagged group on its own.
  const flaggedItems = new Map(); // group -> items
  const pool = [];
  const poolSuspects = [];
  for (const item of live) {
    const group = groupOf(item);
    if (group !== null && quarantine.isFlagged(group)) {
      if (!flaggedItems.has(group)) flaggedItems.set(group, []);
      flaggedItems.get(group).push(item);
    } else if (quarantine.suspects.has(item)) poolSuspects.push(item);
    else pool.push(item);
  }
  const start = quarantine.nextStart(pool.length, size);
  const batches = [];
  for (const list of [
    [...pool.slice(start), ...pool.slice(0, start)],
    poolSuspects,
    ...flaggedItems.values(),
  ]) {
    for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  }

  // Phase 1: one request per batch.
  const failed = [];
  let firstFailure = null;
  for (const batch of batches) {
    const answer = await ask(batch);
    if (answer === true) continue;
    firstFailure ??= answer;
    if (batch.length === 1) found.push({ item: batch[0], err: answer });
    else failed.push(batch);
  }

  // Nothing answered: before spending the search budget, ask the canary. Refused too means the
  // request is at fault, and the poll fails now instead of after 120 more refused requests.
  let canaryAnswered = false;
  if (succeeded === 0 && firstFailure !== null && canary) {
    const answer = await ask([canary], false).catch((err) => err);
    if (answer !== true) {
      quarantine.setGood(null);
      throw firstFailure;
    }
    canaryAnswered = true;
  }

  // Phase 2: search the failed batches depth first until the budget is used up. Both halves of a
  // chunk are asked; the failed ones go on a stack with the first half on top.
  let spare = extraRequests;
  const left = new Set(); // unchecked because the budget ran out
  const stack = failed.reverse();
  while (stack.length > 0) {
    const chunk = stack.pop();
    if (spare <= 0) {
      for (const item of chunk) left.add(item);
      continue;
    }
    const mid = Math.ceil(chunk.length / 2);
    const halves = [chunk.slice(0, mid), chunk.slice(mid)];
    const next = [];
    for (const half of halves) {
      if (spare <= 0) {
        for (const item of half) left.add(item);
        continue;
      }
      spare -= 1;
      const answer = await ask(half);
      if (answer === true) continue;
      if (half.length === 1) found.push({ item: half[0], err: answer });
      else next.push(half);
    }
    for (const half of next.reverse()) stack.push(half);
  }
  for (const item of left) unresolved.add(item);

  let inconclusive = false;
  let quarantineFound = found.length > 0;
  if (quarantineFound) {
    if (canaryAnswered) {
      // already asked, and the platform answers it: the values are at fault
    } else if (canary && !found.some((f) => f.item === canary)) {
      // Is the platform refusing everything? One request with a value that was fine before. A
      // failure of this request of any kind counts as "refused": it must not throw away what the
      // poll already fetched.
      const answer = await ask([canary], false).catch((err) => err);
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

  // What the next poll should batch apart: the unchecked, and the found that were not quarantined.
  quarantine.setSuspects([...left, ...(quarantineFound ? [] : found.map((f) => f.item))]);

  const rejected = [];
  for (const { item, err } of found) {
    unresolved.add(item);
    if (!quarantineFound) continue;
    const group = groupOf(item);
    if (group !== null) quarantine.flag(group);
    const waitMs = quarantine.add(item);
    rejected.push({ item, err, waitMs, strikes: quarantine.strikes(item) });
  }
  return { results, rejected, unresolved, inconclusive, skipped: left.size };
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
