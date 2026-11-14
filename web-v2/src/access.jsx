import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getGuildAccess } from './api.js';

// The signed-in person's dashboard access level in the selected server (src/web/middleware/access.js
// on the server): 'view' reads only, 'inbox' may also act on tickets, appeals, applications and
// suggestions, 'edit' may do everything. The server refuses whatever the level does not allow; this
// only hides or disables the controls, so nobody fills in a form they cannot save.
//
// Until the level is known (and without a provider, as in a page's own tests) everything counts as
// allowed: most people have Edit, and the server has the last word anyway.
const RANK = { view: 1, inbox: 2, edit: 3 };

export const LEVEL_LABEL = { view: 'View only', inbox: 'Inbox only' };

const AccessContext = createContext({ level: 'edit', guildId: null, reload: () => {} });

export function AccessProvider({ guildId, children }) {
  const [state, setState] = useState({ guildId: null, level: 'edit' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!guildId) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => getGuildAccess(guildId))
      .then((data) => {
        if (live) setState({ guildId, level: RANK[data?.level] ? data.level : 'edit' });
      })
      // No answer (no access at all, or offline): the page shows its own error; nothing to hide.
      .catch(() => {
        if (live) setState({ guildId, level: 'edit' });
      });
    return () => {
      live = false;
    };
  }, [guildId, tick]);

  // The level of another server (the previous one, while the new one loads) is not used.
  const level = state.guildId === guildId ? state.level : 'edit';
  return <AccessContext.Provider value={{ level, guildId, reload }}>{children}</AccessContext.Provider>;
}

/**
 * The level in the selected server, and whether it reaches a need:
 *   const { can } = useAccess(); <button disabled={!can('inbox')}>Reply</button>
 */
export function useAccess() {
  const { level, guildId, reload } = useContext(AccessContext);
  return { level, guildId, reload, can: (need) => (RANK[level] ?? 0) >= RANK[need] };
}

/**
 * Disables every control inside when the level does not reach `need` (a <fieldset disabled>), and
 * says why once with `note`. For a part of a page that only changes things: a settings form, a
 * reply box, decision buttons. Links and read-only text stay usable.
 */
export function AccessLock({ need = 'edit', note = false, children }) {
  const { level, can } = useAccess();
  const locked = !can(need);
  return (
    <>
      {locked && note ? (
        <p className="v2-note v2-access-note">
          {LEVEL_LABEL[level] ?? 'Limited access'}: you can look at this, but not change it.
        </p>
      ) : null}
      <fieldset className="v2-access-lock" disabled={locked}>
        {children}
      </fieldset>
    </>
  );
}

/** "View only" / "Inbox only" in the top bar, when the selected server gives less than Edit. */
export function AccessBadge() {
  const { level } = useAccess();
  const label = LEVEL_LABEL[level];
  if (!label) return null;
  return (
    <span
      className="v2-status-pill is-warning v2-access-badge"
      title={
        level === 'view'
          ? 'You can look at everything in this server, but not change anything.'
          : 'You can handle tickets, appeals, applications and suggestions, and look at everything else.'
      }
    >
      {label}
    </span>
  );
}
