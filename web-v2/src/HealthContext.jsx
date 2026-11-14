import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getGuildHealth } from './api.js';

// One read of the server's permission health (GET /guilds/:id/health) shared by the module pages (their
// own list of problems) and every role and channel picker that warns about a choice. Without a provider
// (a page outside the dashboard shell) there is simply no warning.
const HealthContext = createContext(null);

// The check is read again when the person comes back to the tab, at most this often. This read may be
// served from the server's minute-old copy; "Check again" asks for a fresh look.
const REFRESH_MIN_MS = 30_000;

export const TOO_SOON = 'Checked recently — try again in a moment.';

export function HealthProvider({ guildId, children }) {
  // `key` is the server the answer belongs to: the last answer stays while the next one is read, but
  // never for another server.
  const [state, setState] = useState({ health: null, key: undefined });
  const [rechecking, setRechecking] = useState(false);
  const [notice, setNotice] = useState('');
  const seq = useRef(0);
  const guild = useRef(guildId);
  guild.current = guildId;

  const read = useCallback(async ({ refresh = false } = {}) => {
    const id = guild.current;
    if (!id) return;
    const mine = ++seq.current;
    try {
      const health = await getGuildHealth(id, { refresh });
      if (seq.current !== mine) return;
      setState({ health, key: id });
      setNotice('');
    } catch (err) {
      if (seq.current !== mine) return;
      // A failed or refused read must never look like "all fixed": the last answer stays. A server that
      // answers 429 says the check was just made.
      if (refresh && err?.status === 429) setNotice(TOO_SOON);
    }
  }, []);

  useEffect(() => {
    setNotice('');
    read();
  }, [guildId, read]);

  useEffect(() => {
    let last = Date.now();
    const again = () => {
      if (document.visibilityState === 'hidden' || Date.now() - last < REFRESH_MIN_MS) return;
      last = Date.now();
      read();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [read]);

  /** Read again after a save (the server has dropped its cached copy). */
  const refresh = useCallback(() => {
    read();
  }, [read]);
  /** "Check again": ask the server to look again now, not to serve its minute-old copy. */
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      await read({ refresh: true });
    } finally {
      setRechecking(false);
    }
  }, [read]);

  // Not the previous server's answer while this one's loads.
  const health = state.key === guildId ? state.health : null;
  return (
    <HealthContext.Provider value={{ health, rechecking, notice, refresh, recheck }}>
      {children}
    </HealthContext.Provider>
  );
}

/** @returns {{ health: object | null, rechecking: boolean, notice: string, refresh: () => void, recheck: () => Promise<void> } | null} */
export function useHealth() {
  return useContext(HealthContext);
}
