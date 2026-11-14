import { createContext, useContext, useEffect, useState } from 'react';
import { getOverview } from './api.js';
import { useApiData } from './useApiData.js';

// Shares one `getOverview(guildId)` fetch between the Overview page and the
// sidebar's module list, so they can't drift out of sync — toggling a
// module on Overview patches this shared state via `setData`, and the
// sidebar (reading the same state) re-renders immediately, no refresh
// needed. Also fixes the double-fetch this replaced: both consumers used to
// call getOverview() independently for the same guild.
const OverviewContext = createContext(null);

// The inbox counts in the sidebar come from this data, so it is read again when the person comes back to
// the tab (they have probably handled a ticket or an appeal elsewhere), at most this often.
const REFRESH_MIN_MS = 30_000;

export function OverviewProvider({ guildId, children }) {
  const [tick, setTick] = useState(0);
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
  // `dataGuildId` is the server `data` belongs to: useApiData keeps the previous server's data
  // while the new one loads, and a page that acts on a card must not use it for another server.
  const { dataKey, ...state } = useApiData(
    () => (guildId ? getOverview(guildId) : Promise.resolve(null)),
    [guildId, tick],
    guildId
  );
  return (
    <OverviewContext.Provider value={{ ...state, dataGuildId: dataKey, reload: () => setTick((t) => t + 1) }}>
      {children}
    </OverviewContext.Provider>
  );
}

/** @returns {{ data: object | null, dataGuildId: string | undefined, loading: boolean, error: Error | null, setData: Function, reload: () => void }} */
export function useOverview() {
  return useContext(OverviewContext);
}
