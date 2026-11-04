import { useEffect, useRef, useState } from 'react';

/**
 * Fetch-on-deps-change, keeping the previous result visible while a new
 * fetch is in flight instead of blanking back to a loading state — that's
 * what caused the flash when switching servers (each nav briefly rendered
 * "Loading…" over nothing before the new guild's data arrived). A sequence
 * number (not a boolean "cancelled" flag) discards a response that resolves
 * after a newer one already has, so a slow first fetch can't clobber a
 * faster later one.
 *
 * Because the old result stays visible, `key` (optional) says what the
 * result belongs to: whatever `key` was when the fetch started comes back
 * as `dataKey` once its result lands. A caller can then tell the previous
 * server's data from the current server's.
 */
export function useApiData(fetchFn, deps, key) {
  const [state, setState] = useState({ data: null, loading: true, error: null, dataKey: undefined });
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchFn()
      .then((data) => {
        if (seq.current === mySeq) setState({ data, loading: false, error: null, dataKey: key });
      })
      .catch((error) => {
        if (seq.current === mySeq) setState({ data: null, loading: false, error, dataKey: undefined });
      });
    // deps is the caller's own dependency array (this project has no
    // eslint-plugin-react-hooks to police it), by design — fetchFn is a
    // fresh closure every render and isn't meant to be a dep itself.
  }, deps);

  // Escape hatch for a page to patch its own data after a save, without a
  // full refetch — e.g. Leaderboard flipping `publicLeaderboard` in place.
  const setData = (updater) =>
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }));

  return { ...state, setData };
}
