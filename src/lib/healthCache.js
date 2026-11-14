// A short-lived per-server cache for the permission and role-hierarchy health report
// (src/web/lib/permissionHealth.js). The report walks every module's settings and every channel and
// role of the server, so it is built at most once a minute per server; a settings save drops the entry
// so the next read sees the change. It lives here, not in the web layer, so the database layer can
// invalidate it without depending on the web layer.

export const HEALTH_TTL_MS = 60_000;
// More servers than this and the oldest entries go first: a cache entry is only a minute of work.
const MAX_ENTRIES = 500;

/** @type {Map<string, { at: number, value: any }>} */
const entries = new Map();
/** @type {Map<string, Promise<any>>} */
const building = new Map();
// A save that lands while a report is being built must not be overwritten by that (older) report.
const generation = new Map();

const generationOf = (key) => generation.get(key) ?? 0;

/** The cached report for a server key, or undefined when there is none or it is older than the TTL. */
export function cachedHealth(key, now = Date.now()) {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.at >= HEALTH_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return hit.value;
}

/**
 * The cached report, or the one `build()` makes (stored for the next minute). Two callers that ask
 * while a report is being built share it.
 * @template T
 * @param {string} key  the server key
 * @param {() => Promise<T>} build
 * @param {{ fresh?: boolean, now?: number }} [opts]  `fresh` skips the cached copy (an explicit re-check)
 * @returns {Promise<T>}
 */
export async function healthFor(key, build, { fresh = false, now = Date.now() } = {}) {
  if (!fresh) {
    const hit = cachedHealth(key, now);
    if (hit !== undefined) return hit;
    const running = building.get(key);
    if (running) return running;
  }
  const started = generationOf(key);
  const promise = (async () => {
    try {
      const value = await build();
      // Only keep the report when nothing was saved while it was built.
      if (generationOf(key) === started) {
        entries.set(key, { at: now, value });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      return value;
    } finally {
      if (building.get(key) === promise) building.delete(key);
    }
  })();
  building.set(key, promise);
  return promise;
}

/** Drop a server's cached report: its settings changed. Safe to call for a server with none. */
export function invalidateHealth(key) {
  if (!key) return;
  entries.delete(key);
  building.delete(key);
  // One small number per server that ever saved; the map stays as small as the server list.
  generation.set(key, generationOf(key) + 1);
}

/** Forget everything (tests). */
export function resetHealthCache() {
  entries.clear();
  building.clear();
  generation.clear();
}
