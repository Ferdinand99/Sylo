// Drop stale entries from a long-lived in-memory Map now and then. Per-user cooldowns and
// debounces are only read again by the same user; without a sweep, every user ever seen stays.

/**
 * @template V
 * @param {Map<unknown, V>} map
 * @param {(value: V, now: number) => boolean} isStale
 * @param {number} [everyMs]
 * @returns {() => void} a function that sweeps once (for tests)
 */
export function sweepMap(map, isStale, everyMs = 10 * 60 * 1000) {
  const sweep = () => {
    const now = Date.now();
    for (const [key, value] of map) if (isStale(value, now)) map.delete(key);
  };
  setInterval(sweep, everyMs).unref();
  return sweep;
}
