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
      err.kind === 'conflict'
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

/**
 * @param {{
 *   checker: { get(opts?: { force?: boolean }): Promise<any> },
 *   wren: ReturnType<typeof import('../../lib/wiseWren.js').createWrenClient> | null,
 *   now?: () => number,
 * }} deps
 */
export function createUpdateService({ checker, wren, now = Date.now }) {
  let seen = null; // { at, value } of the last Wise Wren read

  const drop = () => {
    seen = null;
  };

  async function readWren() {
    if (seen && now() - seen.at < WREN_CACHE_MS) return seen.value;
    const value = await readWrenUncached();
    seen = { at: now(), value };
    return value;
  }

  async function readWrenUncached() {
    const out = { target: null, readable: true, error: null, latestRun: null };
    try {
      out.target = await wren.target();
    } catch (err) {
      if (err instanceof WrenError && err.kind === 'forbidden') {
        // A token that may approve but not read: the notice still works, from the GitHub check.
        out.readable = false;
      } else if (err instanceof WrenError) {
        out.error = { code: `wren_${err.kind}`, message: err.message };
        return out;
      } else throw err;
    }
    try {
      out.latestRun = await wren.latestRun();
    } catch (err) {
      if (!(err instanceof WrenError)) throw err;
      // Not readable (or Wren hiccuped): the page just has no run to show.
    }
    return out;
  }

  /** Why "Update now" is not offered, or null when it is. */
  function whyNot(check, w) {
    if (w.error) return null;
    if (w.latestRun && !w.latestRun.finished) return 'An update of Sylo is already running in Wise Wren.';
    if (!w.readable) return check.available ? null : 'No newer Sylo release is out.';
    const t = w.target;
    if (!t) return null;
    if (t.blockedReason) return `Wise Wren would refuse it: ${t.blockedReason}`;
    if (t.mode === 'notify') {
      return 'Wise Wren only notifies for this target. Change its mode in Wise Wren to allow updates.';
    }
    if (t.status === 'update') return null;
    if (t.status === 'current')
      return 'Wise Wren does not see an update yet. It checks every few hours; use Check now there.';
    return 'Wise Wren cannot tell yet whether Sylo has an update.';
  }

  /**
   * The state for GET /api/v2/update.
   * @param {{ force?: boolean }} [opts]
   */
  async function status({ force = false } = {}) {
    const check = await checker.get({ force });
    if (!wren) return { ...check, wren: null };
    if (force) drop();
    const w = await readWren();
    const blocked = whyNot(check, w);
    return {
      ...check,
      wren: {
        configured: true,
        error: w.error,
        readable: w.readable,
        target: w.target
          ? {
              name: w.target.name,
              server: w.target.server,
              status: w.target.status,
              installedVersion: w.target.installedVersion,
              latestVersion: w.target.latestVersion,
              mode: w.target.mode,
              lastCheckedAt: w.target.lastCheckedAt,
            }
          : null,
        // Wren sees an update, whatever the GitHub check says (they can differ for a while).
        updateSeen: w.target?.status === 'update',
        canApprove: !w.error && blocked === null,
        whyNot: blocked,
        latestRun: w.latestRun,
      },
    };
  }

  /**
   * Ask Wise Wren to update Sylo now. Approves exactly the version Wren shows when it can be read.
   * @returns {Promise<{ runId: number, status: string, from: string }>}
   */
  async function approve() {
    if (!wren) throw new UpdateError(404, 'wren_off', 'Wise Wren is not set up for this Sylo.');
    // Always a fresh read: the approval must be for the version Wren shows now.
    drop();
    const w = await readWren();
    if (w.error) throw new UpdateError(502, w.error.code, w.error.message);
    const check = await checker.get();
    const why = whyNot(check, w);
    if (why) throw new UpdateError(409, 'not_approvable', why);
    const { runId, status } = await wren.approve(w.target?.versionKey ?? null);
    drop();
    return { runId, status, from: check.current };
  }

  /** One run for GET /api/v2/update/wren/runs/:id; `readable: false` when the token cannot read runs. */
  async function run(id) {
    if (!wren) throw new UpdateError(404, 'wren_off', 'Wise Wren is not set up for this Sylo.');
    try {
      return { readable: true, run: await wren.run(id) };
    } catch (err) {
      if (err instanceof WrenError && err.kind === 'forbidden') return { readable: false, run: null };
      throw err;
    }
  }

  return { status, approve, run, drop };
}
