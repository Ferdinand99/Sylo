// How reachable each YouTube channel's Atom feed and live page are, kept in memory (a restart forgets it, which
// is fine: a feed that is still broken is noticed again within a few polls).
//
// youtube.com/feeds/videos.xml answers 404 (and now and then 5xx) for real channels at random, so
// one failed poll is not worth a log line. Instead each channel counts its consecutive failures:
//   - the channel is polled less often while it fails (exponential backoff, capped at 30 minutes)
//     and again at the normal rate once it answers;
//   - one warning is logged after FEED_WARN_AFTER failures in a row, and one more line when the
//     feed answers again after that warning (both warnings, so both reach the stored dev log);
//   - a channel whose feed has answered 404 without a break for FEED_DEAD_AFTER_MS is reported to
//     server admins by the health check (web/lib/permissionHealth.js, via deadFeedFor()).
// The live page of a channel is tracked the same way (liveTracker), apart from the feed.
// The state is per YouTube channel, not per server: the feed is the same for everyone who watches it.
import { log } from '../../lib/log.js';

const MINUTE_MS = 60_000;
/** Consecutive failed polls before the one warning in the log. */
export const FEED_WARN_AFTER = 6;
/** A feed that has failed (404) for this long without a break is shown to server admins. */
export const FEED_DEAD_AFTER_MS = 24 * 60 * MINUTE_MS;
/** The longest a failing feed waits between two polls. */
export const FEED_BACKOFF_CAP_MS = 30 * MINUTE_MS;
// Polls come at fixed intervals, so one that is due "now" can arrive a few seconds before the
// computed time; this much early still counts as due.
const DUE_SLACK_MS = 30_000;

/**
 * Wait after the `failures`-th failure in a row: one poll interval after the first, then doubling,
 * never more than FEED_BACKOFF_CAP_MS. With a 3-minute poll: 3, 6, 12, 24, 30, 30 ... minutes.
 * @param {number} failures  consecutive failures so far (1 for the first)
 * @param {number} pollMs  the normal poll interval
 */
export function feedBackoffMs(failures, pollMs) {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(FEED_BACKOFF_CAP_MS, pollMs * 2 ** Math.min(n - 1, 20));
}

/** A fetch that failed for a reason outside Sylo: an HTTP error status, a timeout, a network error. */
export class FeedUnavailableError extends Error {
  /** @param {string} message @param {number|null} status  the HTTP status, null for a timeout or network error */
  constructor(message, status = null) {
    super(message);
    this.name = 'FeedUnavailableError';
    this.status = status;
  }
}

/**
 * The failure state of one kind of YouTube fetch, per channel.
 * @param {string} what  how the log lines name it ("the YouTube feed", "the YouTube live page")
 */
function makeTracker(what) {
  /** @type {Map<string, { failures: number, firstFailureAt: number, notFoundSince: number|null, lastStatus: number|null, lastReason: string, nextTryAt: number, warned: boolean }>} */
  const state = new Map();
  const describe = (s) => (s.lastStatus != null ? `HTTP ${s.lastStatus}` : s.lastReason);

  return {
    /** Should this channel be fetched now? True unless it failed lately and is backing off. */
    due(channelId, now = Date.now()) {
      const s = state.get(channelId);
      return !s || now >= s.nextTryAt - DUE_SLACK_MS;
    },

    /**
     * Record a failed fetch. Logs nothing, except one warning the moment the failures in a row
     * reach FEED_WARN_AFTER.
     * @param {string} channelId
     * @param {FeedUnavailableError} err
     * @param {number} pollMs  the normal poll interval, the base of the backoff
     * @param {number} [now]
     */
    failure(channelId, err, pollMs, now = Date.now()) {
      const s = state.get(channelId) ?? {
        failures: 0,
        firstFailureAt: now,
        notFoundSince: null,
        lastStatus: null,
        lastReason: '',
        nextTryAt: now,
        warned: false,
      };
      s.failures += 1;
      s.lastStatus = err.status ?? null;
      s.lastReason = err.message;
      // "404 without a break": any other kind of failure starts the count again.
      s.notFoundSince = s.lastStatus === 404 ? (s.notFoundSince ?? now) : null;
      s.nextTryAt = now + feedBackoffMs(s.failures, pollMs);
      state.set(channelId, s);
      if (s.failures >= FEED_WARN_AFTER && !s.warned) {
        s.warned = true;
        log.warn(
          'youtube-alerts',
          `${channelId}: ${what} failed ${s.failures} polls in a row (last: ${describe(s)}); polling it less often until it answers`
        );
      }
      return { failures: s.failures, nextTryAt: s.nextTryAt };
    },

    /** Record a fetch that got an answer. Logs one line if a warning had been logged for this channel. */
    success(channelId) {
      const s = state.get(channelId);
      if (!s) return;
      state.delete(channelId);
      // A warning, like the one before it: log.js sends only warnings and errors to the stored dev log.
      if (s.warned) {
        log.warn('youtube-alerts', `${channelId}: ${what} answers again after ${s.failures} failed polls`);
      }
    },

    /** Has this channel answered 404 without a break for `minMs`? */
    notFoundFor(channelId, now = Date.now(), minMs = FEED_DEAD_AFTER_MS) {
      const s = state.get(channelId);
      if (!s || s.notFoundSince == null || now - s.notFoundSince < minMs) return null;
      return { since: s.notFoundSince, failures: s.failures };
    },

    /** Forget every channel that is not in `active` (an alert that was removed must not keep its state). */
    prune(active) {
      for (const id of state.keys()) if (!active.has(id)) state.delete(id);
    },

    /** How many channels are tracked (tests). */
    size: () => state.size,
    clear: () => state.clear(),
  };
}

const feed = makeTracker('the YouTube feed');
const live = makeTracker('the YouTube live page');

/** Should the feed of this channel be polled now? */
export const feedDue = feed.due;
export const recordFeedFailure = feed.failure;
export const recordFeedSuccess = feed.success;
/**
 * Has this channel's feed answered 404 without a break for `minMs`? Only a 404 counts: a feed that
 * fails with a 5xx or a timeout is YouTube's problem, not a channel an admin can fix.
 * @returns {{ since: number, failures: number }|null}
 */
export const deadFeedFor = feed.notFoundFor;
export const pruneFeedHealth = feed.prune;
export const feedHealthSize = feed.size;

export const liveDue = live.due;
export const recordLiveFailure = live.failure;
export const recordLiveSuccess = live.success;
export const pruneLiveHealth = live.prune;
export const liveHealthSize = live.size;

/** For tests only. */
export function _resetFeedHealthForTests() {
  feed.clear();
  live.clear();
}
