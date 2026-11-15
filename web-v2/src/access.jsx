import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getGuildAccess } from './api.js';
import { readShowEverything, writeShowEverything } from './util.js';

// The signed-in person's dashboard access level in the selected server (src/web/middleware/access.js
// on the server): 'view' reads only, 'inbox' may also act on tickets, appeals, applications and
// suggestions, 'edit' may do everything. The server refuses whatever the level does not allow; this
// only hides or disables the controls, so nobody fills in a form they cannot save.
//
// Until the level is known (and without a provider, as in a page's own tests) everything counts as
// allowed: most people have Edit, and the server has the last word anyway.
const RANK = { view: 1, inbox: 2, edit: 3 };

export const LEVEL_LABEL = { view: 'View only', inbox: 'Inbox only' };

// `ready` is false while the level of the selected server is still being read. `showEverything` is the
// Inbox person's choice to see the full navigation instead of the focused view (see useAccess).
const AccessContext = createContext({
  level: 'edit',
  guildId: null,
  reload: () => {},
  ready: true,
  showEverything: false,
  setShowEverything: () => {},
});

export function AccessProvider({ guildId, children }) {
  const [state, setState] = useState({ guildId: null, level: 'edit' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [showEverything, setShow] = useState(readShowEverything);
  const setShowEverything = useCallback((on) => {
    setShow(Boolean(on));
    writeShowEverything(Boolean(on));
  }, []);

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
  const known = state.guildId === guildId;
  const level = known ? state.level : 'edit';
  // Without a server there is nothing to wait for.
  const ready = !guildId || known;
  return (
    <AccessContext.Provider value={{ level, guildId, reload, ready, showEverything, setShowEverything }}>
      {children}
    </AccessContext.Provider>
  );
}

/**
 * The level in the selected server, and whether it reaches a need:
 *   const { can } = useAccess(); <button disabled={!can('inbox')}>Reply</button>
 */
export function useAccess() {
  const { level, guildId, reload, ready, showEverything, setShowEverything } = useContext(AccessContext);
  return {
    level,
    guildId,
    reload,
    ready,
    can: (need) => (RANK[level] ?? 0) >= RANK[need],
    // The focused moderator view: a person whose level here is exactly Inbox gets the moderation tools
    // instead of the whole dashboard, unless they chose "Show everything". View keeps the full read-only
    // dashboard (observers need the whole picture) and Edit is unchanged. `canFocus` is whether the choice
    // is theirs to make at all.
    canFocus: level === 'inbox',
    focused: level === 'inbox' && !showEverything,
    showEverything,
    setShowEverything,
  };
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

/**
 * In place of what the inboxes contain (a ticket's messages, an application's answers) for someone
 * with View access: the server answers those with 403 and `required: 'inbox'`, and blanks the content
 * in the lists (`contentHidden`). `list` is the wording for a list that is shown without it.
 */
export function NeedsInbox({ what, list = false }) {
  return (
    <p className="v2-note v2-access-note">
      {list
        ? `View only: you see the ${what}, not what they say. Reading them needs Inbox access.`
        : `Reading ${what} needs Inbox access. Your access in this server is View only.`}
    </p>
  );
}

/** Is this error the server refusing because the content needs Inbox? */
export const needsInbox = (error) => error?.status === 403 && error?.required === 'inbox';
