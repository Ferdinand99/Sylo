import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getGuildHealth } from './api.js';
import { useApiData } from './useApiData.js';

// One read of the server's permission health (GET /guilds/:id/health) shared by the module pages (their
// own list of problems) and every role and channel picker that warns about a choice. Without a provider
// (a page outside the dashboard shell) there is simply no warning.
const HealthContext = createContext(null);

// The check is read again when the person comes back to the tab (they may have fixed a role in
// Discord), at most this often.
const REFRESH_MIN_MS = 30_000;

export function HealthProvider({ guildId, children }) {
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState === 'hidden' || Date.now() - last < REFRESH_MIN_MS) return;
      last = Date.now();
      setTick((t) => t + 1);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const { data, dataKey, loading } = useApiData(
    () => {
      if (!guildId) return Promise.resolve(null);
      const refresh = fresh.current;
      fresh.current = false;
      // A failing check must never get in the way of a form: no answer means no warning.
      return getGuildHealth(guildId, { refresh }).catch(() => null);
    },
    [guildId, tick],
    guildId
  );
  /** Read again after a save (the server has dropped its cached copy). */
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** "Check again": ask the server to look again now, not to serve its minute-old copy. */
  const recheck = useCallback(() => {
    fresh.current = true;
    setTick((t) => t + 1);
  }, []);
  // Not the previous server's answer while this one's loads.
  const health = dataKey === guildId ? data : null;
  return (
    <HealthContext.Provider value={{ health, loading, refresh, recheck }}>{children}</HealthContext.Provider>
  );
}

/** @returns {{ health: object | null, loading: boolean, refresh: () => void, recheck: () => void } | null} */
export function useHealth() {
  return useContext(HealthContext);
}
