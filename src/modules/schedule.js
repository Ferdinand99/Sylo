// One start/stop registry for module timers.
//
// A module registers its recurring work with `every()` and its per-item one-shots with
// `after()` instead of calling setInterval/setTimeout at import time. Registering only records
// the work: nothing runs until `startSchedules()` (src/index.js, once the bots and the web server
// are up), and `stopSchedules()` clears every timer on shutdown and waits briefly for ticks that
// are still running.
//
// - A tick that is still running when the next one is due is skipped (no overlap per registration).
// - A tick that throws or rejects is logged with its module id; the schedule keeps going.
// - Every timer is unref()'d, so a stray timer never keeps a process (or a test run) alive.
import { log } from '../lib/log.js';

/** How long stopSchedules() waits for running ticks before it gives up and resolves anyway. */
export const STOP_GRACE_MS = 3000;

/** @typedef {{ moduleId: string, ms: number, firstDelayMs: number, fn: () => unknown, running: Promise<void> | null }} Registration */
/** @typedef {{ moduleId: string, ms: number, fn: () => unknown, timer: unknown, cancelled: boolean }} OneShot */

/** @type {Registration[]} */
let registrations = [];
/** One-shots registered before startSchedules(); armed when it runs. @type {Set<OneShot>} */
let queued = new Set();
/** Every live timer handle (intervals, first-tick timeouts, armed one-shots). @type {Set<unknown>} */
let timers = new Set();
/** Promises of ticks that are running right now. @type {Set<Promise<void>>} */
let running = new Set();
let started = false;
/** Set by stopSchedules(): a late after() then does nothing instead of queueing for a restart. */
let closed = false;

function logFailure(moduleId, err) {
  log.error(`module:${moduleId}`, 'scheduled task failed:', err);
}

/**
 * Run `fn` once, catching a throw or a rejection. Returns the promise that tracks the run, or null
 * when `fn` finished synchronously.
 * @returns {Promise<void> | null}
 */
function invoke(moduleId, fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    logFailure(moduleId, err);
    return null;
  }
  if (!result || typeof result.then !== 'function') return null;
  const tracked = Promise.resolve(result)
    .catch((err) => logFailure(moduleId, err))
    .finally(() => running.delete(tracked));
  running.add(tracked);
  return tracked;
}

function runTick(reg) {
  if (!started || reg.running) return; // stopped, or the previous run is still pending
  const tracked = invoke(reg.moduleId, reg.fn);
  if (!tracked) return;
  reg.running = tracked;
  tracked.finally(() => {
    if (reg.running === tracked) reg.running = null;
  });
}

function arm(reg) {
  const interval = setInterval(() => runTick(reg), reg.ms);
  interval.unref();
  timers.add(interval);
  if (reg.firstDelayMs === reg.ms) return;
  if (reg.firstDelayMs < reg.ms) {
    // The first tick comes early; the interval keeps its own cadence from the start.
    const first = setTimeout(() => {
      timers.delete(first);
      runTick(reg);
    }, reg.firstDelayMs);
    first.unref();
    timers.add(first);
    return;
  }
  // A first tick later than one interval: hold the interval back until it has run.
  clearInterval(interval);
  timers.delete(interval);
  const first = setTimeout(() => {
    timers.delete(first);
    runTick(reg);
    const later = setInterval(() => runTick(reg), reg.ms);
    later.unref();
    timers.add(later);
  }, reg.firstDelayMs);
  first.unref();
  timers.add(first);
}

function armOneShot(shot) {
  shot.timer = setTimeout(() => {
    timers.delete(shot.timer);
    if (!shot.cancelled) invoke(shot.moduleId, shot.fn);
  }, shot.ms);
  shot.timer.unref();
  timers.add(shot.timer);
}

/**
 * Register recurring work. Nothing runs before startSchedules(); a registration made after it
 * starts at once.
 * @param {string} moduleId  the module's registry id (or 'core'), used when a tick fails
 * @param {number} ms  the interval
 * @param {() => unknown} fn  the tick; may return a promise
 * @param {{ firstDelayMs?: number }} [opts]  delay of the first tick (default: one interval)
 */
export function every(moduleId, ms, fn, { firstDelayMs = ms } = {}) {
  /** @type {Registration} */
  const reg = { moduleId, ms, firstDelayMs, fn, running: null };
  registrations.push(reg);
  if (started) arm(reg);
}

/**
 * Run `fn` once after `ms`. Queued until startSchedules(); after that it starts at once. Cleared
 * by stopSchedules().
 * @param {string} moduleId
 * @param {number} ms
 * @param {() => unknown} fn
 * @returns {{ cancel: () => void }}
 */
export function after(moduleId, ms, fn) {
  /** @type {OneShot} */
  const shot = { moduleId, ms, fn, timer: null, cancelled: false };
  const handle = {
    cancel() {
      shot.cancelled = true;
      queued.delete(shot);
      if (shot.timer) {
        clearTimeout(shot.timer);
        timers.delete(shot.timer);
      }
    },
  };
  if (started) armOneShot(shot);
  else if (!closed) queued.add(shot);
  return handle;
}

/** Start every registered schedule. Calling it again does nothing. */
export function startSchedules() {
  if (started) return;
  started = true;
  closed = false;
  for (const reg of registrations) arm(reg);
  const waiting = [...queued];
  queued.clear();
  for (const shot of waiting) armOneShot(shot);
}

/**
 * Clear every timer and stop new ticks, then wait for ticks that are running, but no longer than
 * STOP_GRACE_MS.
 * @returns {Promise<void>}
 */
export async function stopSchedules() {
  started = false;
  closed = true;
  for (const timer of timers) clearTimeout(timer); // clearTimeout also clears intervals
  timers.clear();
  queued.clear();
  if (running.size === 0) return;
  let grace;
  const gave = new Promise((resolve) => {
    grace = setTimeout(resolve, STOP_GRACE_MS);
    grace.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled([...running]), gave]);
  } finally {
    clearTimeout(grace);
  }
}

/** How many `every()` registrations exist (started or not). For tests. */
export function scheduledCount() {
  return registrations.length;
}

/** How many timers are live right now: zero until startSchedules(). For tests. */
export function activeTimerCount() {
  return timers.size;
}

/** Drop every registration and timer. For tests only. */
export function _resetForTests() {
  for (const timer of timers) clearTimeout(timer);
  timers = new Set();
  registrations = [];
  queued = new Set();
  running = new Set();
  started = false;
  closed = false;
}
