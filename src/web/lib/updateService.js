// What the operators' update notice shows and does, built from the release check (lib/updateCheck.js) and
// the optional Wise Wren client (lib/wiseWren.js). The routes (routes/v2Update.js) only call this.
//
// The Wise Wren side is read live but kept for a few seconds, so several operators (or one dashboard
// polling) do not turn into a request to Wise Wren each. Nothing here ever includes the Wise Wren address
// or token in an answer.
import { WrenError } from '../../lib/wiseWren.js';

export const WREN_CACHE_MS = 10_000;

/** A refusal the route answers with `status` and `{ error, code }`. */
export class UpdateError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'UpdateError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Wise Wren's errors as the HTTP answer to the dashboard. Never 401 or 403: those tell the dashboard that
 * the operator's own session is gone or not allowed, and here it is Wise Wren that said no.
 * @param {unknown} err
 */
export function toUpdateError(err) {
  if (err instanceof UpdateError) return err;
  if (err instanceof WrenError) {
    const status =
      err.kind === 'conflict' || err.kind === 'refused'
        ? 409
        : err.kind === 'not_found'
          ? 404
          : err.kind === 'rate_limited'
            ? 429
            : 502;
    return new UpdateError(status, `wren_${err.kind}`, err.message);
  }
  return null;
}

/** What the dashboard tells an operator in open mode, where nobody is signed in. */
export const OPEN_MODE_TEXT =
  'Update now needs a dashboard login: without one, anyone who can reach this dashboard could use it. Set up a login, or set WISE_WREN_ALLOW_OPEN_MODE=true to allow it anyway.';

/**
 * @param {{
 *   checker: { get(opts?: { force?: boolean }): Promise<any> },
 *   wren: ReturnType<typeof import('../../lib/wiseWren.js').createWrenClient> | null,
 *   store?: { get(): Promise<{ id: number } | null>, set(run: { id: number }): Promise<void> },
 *   openModeBlocked?: () => boolean,
 *   now?: () => number,
 * }} deps
 *
 * `store` keeps the run Sylo last approved, so "Update now" stays off while it runs, also across the
 * restart the update causes. It is a run id only: the Wise Wren target token may read a run by id but
 * not list runs. `openModeBlocked` says Update now is refused because nobody is signed in.
 */
export function createUpdateService({
  checker,
  wren,
  store = null,
  openModeBlocked = () => false,
  now = Date.now,
}) {
  let seen = null; // { at, value } of the last Wise Wren read
  let inflight = null; // the read in progress, shared by everyone who asks meanwhile
  let lastRunId = null; // the run approved by this process

  const drop = () => {
    seen = null;
    inflight = null;
  };

  async function knownRunId() {
    if (lastRunId) return lastRunId;
    try {
      return (await store?.get())?.id ?? null;
    } catch {
      return null;
    }
  }

  function readWren() {
    if (seen && now() - seen.at < WREN_CACHE_MS) return Promise.resolve(seen.value);
    if (!inflight) {
      const mine = readWrenUncached()
        .then((value) => {
          if (inflight === mine) seen = { at: now(), value };
          return value;
        })
        .finally(() => {
          if (inflight === mine) inflight = null;
        });
      inflight = mine;
    }
    return inflight;
  }

  // The target and the run Sylo approved, asked at the same time (a read is short or it is broken).
  async function readWrenUncached() {
    const out = { target: null, error: null, latestRun: null };
    const runId = await knownRunId();
    const [target, run] = await Promise.allSettled([wren.target(), runId ? wren.run(runId) : null]);
    if (target.status === 'rejected') {
      if (!(target.reason instanceof WrenError)) throw target.reason;
      // A 403 here means the token is for another target (or may not read this one): an error to fix.
      out.error = { code: `wren_${target.reason.kind}`, message: target.reason.message };
      return out;
    }
    out.target = target.value;
    if (run.status === 'rejected') {
      if (!(run.reason instanceof WrenError)) throw run.reason;
      // Wren hiccuped: the page just has no run to show now.
    } else out.latestRun = run.value;
    return out;
  }

  /** Why "Update now" is not offered, or null when it is. */
  function whyNot(w) {
    if (w.error) return null;
    if (openModeBlocked()) return OPEN_MODE_TEXT;
    if (w.latestRun && !w.latestRun.finished) return 'An update of Sylo is already running in Wise Wren.';
    const t = w.target;
    if (!t) return null;
    if (t.blockedReason) return `Wise Wren would refuse it: ${t.blockedReason}`;
    if (t.mode === 'notify') {
      return 'Wise Wren only notifies for this target. Change its mode in Wise Wren to allow updates.';
    }
    if (t.status === 'update') {
      return t.versionKey ? null : 'Wise Wren shows no version to approve yet. Try again in a moment.';
    }
    if (t.status === 'current')
      return 'Wise Wren does not see an update yet. It checks every few hours; use Check now there.';
    return 'Wise Wren cannot tell yet whether Sylo has an update.';
  }

  /**
   * The state for GET /api/v2/update.
   * @param {{ force?: boolean }} [opts]
   */
  async function status({ force = false } = {}) {
    if (force) drop();
    // GitHub and Wise Wren are asked at the same time.
    const [check, w] = await Promise.all([checker.get({ force }), wren ? readWren() : null]);
    if (!wren) return { ...check, wren: null };
    const blocked = whyNot(w);
    return {
      ...check,
      wren: {
        configured: true,
        error: w.error,
        openMode: openModeBlocked(),
        target: w.target
          ? {
              name: w.target.name,
              server: w.target.server,
              status: w.target.status,
              installedVersion: w.target.installedVersion,
              // Which containers of the stack have the update (names only), and whether Wren requires a
              // snapshot before it updates.
              updates: w.target.updates,
              requireSnapshot: w.target.requireSnapshot,
              latestVersion: w.target.latestVersion,
              mode: w.target.mode,
              lastCheckedAt: w.target.lastCheckedAt,
            }
          : null,
        // Wren sees an update, whatever the GitHub check says (they can differ for a while).
        updateSeen: w.target?.status === 'update',
        canApprove: !w.error && blocked === null,
        whyNot: blocked,
        // The run Sylo last approved (the page follows it while it is not finished).
        latestRun: w.latestRun,
      },
    };
  }

  /**
   * Ask Wise Wren to update Sylo now: exactly the version Wren shows.
   * @returns {Promise<{ runId: number, status: string, from: string }>}
   */
  async function approve() {
    if (!wren) throw new UpdateError(404, 'wren_off', 'Wise Wren is not set up for this Sylo.');
    // Before anything is asked of Wise Wren: nobody is signed in.
    if (openModeBlocked()) throw new UpdateError(409, 'open_mode', OPEN_MODE_TEXT);
    // Always a fresh read: the approval must be for the version Wren shows now.
    drop();
    const w = await readWren();
    if (w.error) throw new UpdateError(502, w.error.code, w.error.message);
    const why = whyNot(w);
    if (why) throw new UpdateError(409, 'not_approvable', why);
    const check = await checker.get();
    const { runId, status } = await wren.approve(w.target.versionKey);
    lastRunId = runId;
    try {
      await store?.set({ id: runId });
    } catch {
      // kept in memory for this process; only a restart would forget it
    }
    drop();
    return { runId, status, from: check.current };
  }

  /** One run for GET /api/v2/update/wren/runs/:id (a run of another target is a not_found). */
  async function run(id) {
    if (!wren) throw new UpdateError(404, 'wren_off', 'Wise Wren is not set up for this Sylo.');
    return { run: await wren.run(id) };
  }

  return { status, approve, run, drop };
}
