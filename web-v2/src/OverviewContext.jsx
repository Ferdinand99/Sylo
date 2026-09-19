import { createContext, useContext } from 'react';
import { getOverview } from './api.js';
import { useApiData } from './useApiData.js';

// Shares one `getOverview(guildId)` fetch between the Overview page and the
// sidebar's module list, so they can't drift out of sync — toggling a
// module on Overview patches this shared state via `setData`, and the
// sidebar (reading the same state) re-renders immediately, no refresh
// needed. Also fixes the double-fetch this replaced: both consumers used to
// call getOverview() independently for the same guild.
const OverviewContext = createContext(null);

export function OverviewProvider({ guildId, children }) {
  const state = useApiData(() => (guildId ? getOverview(guildId) : Promise.resolve(null)), [guildId]);
  return <OverviewContext.Provider value={state}>{children}</OverviewContext.Provider>;
}

/** @returns {{ data: object | null, loading: boolean, error: Error | null, setData: Function }} */
export function useOverview() {
  return useContext(OverviewContext);
}
