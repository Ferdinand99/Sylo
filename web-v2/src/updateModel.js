// The operators' update notice: what the pages share. Pure helpers (the words for a Wise Wren run, the
// stored run id) and one cached read of GET /api/v2/update, so the top bar's badge and the Health page's
// section do not each ask the server on every render.
import { getUpdate } from './api.js';

const RUN_KEY = 'sylo:v2:updateRun';

/** The run the operator started, kept for this tab so a reload during the update picks the progress up again. */
export function readStoredRun() {
  try {
    const run = JSON.parse(sessionStorage.getItem(RUN_KEY) ?? 'null');
    return Number.isSafeInteger(run?.id) && typeof run.from === 'string'
      ? { id: run.id, from: run.from }
      : null;
  } catch {
    return null;
  }
}

export function writeStoredRun(run) {
  try {
    if (run) sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
    else sessionStorage.removeItem(RUN_KEY);
  } catch {
    // ignore: the progress then just does not survive a reload
  }
}

// Wise Wren's step names, in words. A step it adds later shows as it is named.
const STEP_LABELS = {
  preflight: 'Pulling the new version',
  maintenance: 'Opening the maintenance window',
  stop: 'Stopping Sylo',
  snapshot: 'Taking a snapshot of the data',
  update: 'Starting the new version',
  health: 'Checking that Sylo is healthy',
  rollback: 'Rolling back',
  close: 'Cleaning up',
};

export const stepLabel = (step) => STEP_LABELS[step] ?? String(step ?? '');

/**
 * What to tell the operator about a Wise Wren run: `tone` is 'working', 'success' or 'failure', `text` the
 * sentence, `step` the step it is on (while it works).
 * @param {{ status?: string, steps?: { step: string, status: string }[] } | null} run
 */
export function describeRun(run) {
  const status = run?.status ?? 'queued';
  switch (status) {
    case 'queued':
      return { tone: 'working', text: 'Approved. Waiting for the Wise Wren agent to pick the update up.' };
    case 'running': {
      const steps = run?.steps ?? [];
      const current = steps.findLast?.((s) => s.status === 'running') ?? steps[steps.length - 1];
      return {
        tone: 'working',
        text: 'Wise Wren is updating Sylo. Sylo restarts during this and the page reconnects by itself.',
        step: current ? stepLabel(current.step) : null,
      };
    }
    case 'succeeded':
      return { tone: 'success', text: 'Wise Wren finished the update.' };
    case 'rolled_back':
      return {
        tone: 'failure',
        text: 'The new version did not come up healthy, so Wise Wren rolled back. Sylo runs the old version again.',
      };
    case 'failed':
      return {
        tone: 'failure',
        text: 'The update failed before anything was changed. Sylo still runs the old version.',
      };
    case 'rollback_failed':
      return {
        tone: 'failure',
        text: 'The update failed and the rollback failed too. Look at Sylo in Wise Wren now.',
      };
    case 'refused':
      return {
        tone: 'failure',
        text: 'The Wise Wren agent refused the update: its own settings do not allow updating Sylo.',
      };
    case 'cancelled':
      return { tone: 'failure', text: 'The update was cancelled in Wise Wren.' };
    case 'lapsed':
      return {
        tone: 'failure',
        text: 'A newer version appeared before the update started, so it was dropped. Try again.',
      };
    default:
      return { tone: 'working', text: 'Wise Wren is working on the update.' };
  }
}

/**
 * True when a failed poll means Sylo itself is not answering (restarting, or the proxy has no upstream),
 * as opposed to Sylo answering with a Wise Wren error.
 */
export function syloIsDown(err) {
  if (typeof err?.status !== 'number') return true; // the request never got an answer
  return err.status >= 500 && !String(err.code ?? '').startsWith('wren_');
}

const TTL_MS = 5 * 60 * 1000;
let cached = null; // { at, promise }

/**
 * One read of the update status, shared for a few minutes (`fresh` skips the share). A failure is not
 * kept: the next call asks again.
 */
export function loadUpdateStatus({ fresh = false, refresh = false } = {}) {
  if (!fresh && !refresh && cached && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = Promise.resolve().then(() => getUpdate({ refresh }));
  cached = { at: Date.now(), promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

/** For tests. */
export function resetUpdateStatusCache() {
  cached = null;
}
