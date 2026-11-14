// Collects what a dashboard request changes in a server's settings, so the audit entry written for it can
// keep the before and after (src/db/audit.js, src/lib/configSnapshot.js).
//
// A request that may save settings runs inside a capture (the guild routers open one, see
// src/web/routes/v2Api.js). The writers note every change they make in the capture of the request they run in:
//   - setGuildModule (src/db/modules.js) notes a module's config,
//   - the server-settings writers (src/db/guildSettings.js) note the mod-log channel, the embed colour, the
//     bot master roles and the command prefix.
// recordAudit takes the notes its entry is about: a "module:<id>" entry takes that module's, a "settings…"
// entry takes the server settings', and an entry of another kind takes the change of the only module the request
// wrote, if there is exactly one. The bot's own writes, which have no request, are not noted. Notes are
// keyed by server and module, so a request that writes the same module in two servers keeps them apart.
//
// Per setting the first "before" and the last "after" of the request are kept, so a route that saves
// twice still reads as one change.
import { AsyncLocalStorage } from 'node:async_hooks';

const captures = new AsyncLocalStorage();

/**
 * Run `fn` inside a new capture. Express: pass `next`.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithCapture(fn) {
  return captures.run({ modules: new Map(), settings: new Map() }, fn);
}

/** Note a module config write of the current request (no-op outside one). */
export function noteModuleWrite(guildId, moduleId, before, after) {
  const store = captures.getStore();
  if (!store) return;
  const key = `${guildId}|${moduleId}`;
  const seen = store.modules.get(key);
  store.modules.set(key, { guildId, moduleId, before: seen ? seen.before : before, after });
}

/**
 * The change the current request made to a server's module config, and forget it. Undefined when there is none.
 * @returns {{ before: object, after: object } | undefined}
 */
export function takeModuleChange(guildId, moduleId) {
  const store = captures.getStore();
  const key = `${guildId}|${moduleId}`;
  const note = store?.modules.get(key);
  if (!note) return undefined;
  store.modules.delete(key);
  return { before: note.before, after: note.after };
}

/**
 * The change of the only module the request wrote in this server (for an audit entry that is not named
 * "module:<id>", such as the leaderboard switch), and forget it. Undefined when there is none or more than one.
 * @returns {{ before: object, after: object } | undefined}
 */
export function takeOnlyModuleChange(guildId) {
  const store = captures.getStore();
  if (!store) return undefined;
  const mine = [...store.modules.entries()].filter(([, n]) => n.guildId === guildId);
  if (mine.length !== 1) return undefined;
  const [key, note] = mine[0];
  store.modules.delete(key);
  return { before: note.before, after: note.after };
}

/** Note a server setting write of the current request (no-op outside one). `name` is the setting's key in the history. */
export function noteSettingWrite(guildId, name, before, after) {
  const store = captures.getStore();
  if (!store) return;
  const key = `${guildId}|${name}`;
  const seen = store.settings.get(key);
  store.settings.set(key, { guildId, name, before: seen ? seen.before : before, after });
}

/**
 * The server settings the current request changed in this server, as `{ before, after }`, and forget them.
 * Undefined when none was written.
 */
export function takeSettingsChange(guildId) {
  const store = captures.getStore();
  if (!store) return undefined;
  const mine = [...store.settings.entries()].filter(([, n]) => n.guildId === guildId);
  if (!mine.length) return undefined;
  const out = { before: {}, after: {} };
  for (const [key, note] of mine) {
    out.before[note.name] = note.before;
    out.after[note.name] = note.after;
    store.settings.delete(key);
  }
  return out;
}
