import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { confirmDialog } from './ConfirmDialog.jsx';

// Pass as navigate(to, { state: SKIP_UNSAVED_GUARD }) when leaving on purpose
// right after a save, before React has re-rendered the now-clean form. Only
// honoured for that push/replace: the state stays on the history entry, so a
// later Back/Forward onto it must still be guarded.
export const SKIP_UNSAVED_GUARD = { skipUnsavedGuard: true };

/**
 * Warn before unsaved edits are lost: the browser's own prompt on reload /
 * tab close / a full-page link, and a confirm dialog on in-app navigation
 * (needs the data router App.jsx sets up — useBlocker doesn't work under a
 * plain <BrowserRouter>). A router supports one blocker at a time, so call
 * this once per page — <SaveBar> already does.
 */
export function useUnsavedChangesGuard(dirty) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const shouldBlock = useCallback(
    ({ currentLocation, nextLocation, historyAction }) =>
      dirtyRef.current &&
      !(historyAction !== 'POP' && nextLocation.state?.skipUnsavedGuard) &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    []
  );
  const blocker = useBlocker(shouldBlock);
  const asking = useRef(false);

  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return;
    asking.current = true;
    confirmDialog({
      title: 'Leave without saving?',
      body: 'You have unsaved changes on this page. They will be lost if you leave now.',
      confirmLabel: 'Leave page',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    }).then((leave) => {
      asking.current = false;
      // The page may have unmounted while the dialog was open, leaving the
      // blocker in a state that no longer accepts proceed/reset.
      try {
        if (leave) blocker.proceed?.();
        else blocker.reset?.();
      } catch {
        // nothing left to unblock
      }
    });
  }, [blocker]);
}
