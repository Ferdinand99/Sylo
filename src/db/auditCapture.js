// Collects what a dashboard request changes in a module's config, so the audit entry the route writes
// afterwards can keep the before and after of it (src/db/audit.js, src/lib/configSnapshot.js).
//
// A request that may save settings runs inside a capture (the guild routers open one, see
// src/web/routes/v2Api.js). setGuildModule (src/db/modules.js) notes every config it writes in the one of
// the request it runs in, and recordAudit takes the note of the module its entry is about. The bot's own
// writes, which have no request, are not noted.
//
// Per module the first "before" and the last "after" of the request are kept, so a route that saves a
// module twice still reads as one change.
import { AsyncLocalStorage } from 'node:async_hooks';

const captures = new AsyncLocalStorage();

/**
 * Run `fn` inside a new capture. Express: pass `next`.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithCapture(fn) {
  return captures.run({ modules: new Map() }, fn);
}

/** Note a module config write of the current request (no-op outside one). */
export function noteModuleWrite(moduleId, before, after) {
  const store = captures.getStore();
  if (!store) return;
  const seen = store.modules.get(moduleId);
  store.modules.set(moduleId, { before: seen ? seen.before : before, after });
}

/**
 * The change the current request made to a module's config, and forget it. Undefined when there is none.
 * @returns {{ before: object, after: object } | undefined}
 */
export function takeModuleChange(moduleId) {
  const store = captures.getStore();
  const note = store?.modules.get(moduleId);
  if (!note) return undefined;
  store.modules.delete(moduleId);
  return note;
}
