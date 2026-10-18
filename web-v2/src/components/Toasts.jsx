import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from '../notify.js';

const LIFETIME_MS = { error: 10000, info: 5000 };
// Matches .v2-toast.is-leaving's transition in styles.css.
const EXIT_MS = 200;
const MAX_VISIBLE = 4;

const isPaused = (p) => p.hover || p.focus || p.hidden;

// Messages from notify(), stacked bottom-right. Each one can be dismissed and
// goes away by itself. Errors are announced to screen readers at once.
// The stack stays mounted even when empty: a live region has to exist before
// content is added to it, or screen readers miss the first message.
// Auto-dismiss pauses while the pointer is over the stack, while focus is in
// it (someone reaching for ×) and while the tab is hidden, so a message
// can't expire unread.
export default function Toasts() {
  const [items, setItems] = useState([]);
  // Source of truth kept in a ref too, so dedupe and the timers read the
  // current list synchronously instead of from inside a state updater.
  const listRef = useRef([]);
  const nextId = useRef(1);
  // id -> { handle, remaining, startedAt }
  const timers = useRef(new Map());
  const pause = useRef({ hover: false, focus: false, hidden: false });
  const stackRef = useRef(null);

  const commit = useCallback((next) => {
    listRef.current = next;
    setItems(next);
  }, []);

  const dismiss = useCallback(
    (id) => {
      const timer = timers.current.get(id);
      if (timer) clearTimeout(timer.handle);
      timers.current.delete(id);
      if (!listRef.current.some((t) => t.id === id && !t.leaving)) return;
      commit(listRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => {
        commit(listRef.current.filter((t) => t.id !== id));
        // A focused × that gets removed doesn't reliably fire blur — without
        // this the stack could stay paused for good.
        if (!stackRef.current?.contains(document.activeElement)) setPauseRef.current('focus', false);
      }, EXIT_MS);
    },
    [commit]
  );

  const startTimer = useCallback(
    (id) => {
      const timer = timers.current.get(id);
      if (!timer || timer.handle) return;
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => dismiss(id), timer.remaining);
    },
    [dismiss]
  );

  const pauseAll = useCallback(() => {
    for (const timer of timers.current.values()) {
      if (!timer.handle) continue;
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
    }
  }, []);

  const resumeAll = useCallback(() => {
    for (const id of timers.current.keys()) startTimer(id);
  }, [startTimer]);

  const setPause = useCallback(
    (key, value) => {
      const wasPaused = isPaused(pause.current);
      pause.current[key] = value;
      const nowPaused = isPaused(pause.current);
      if (!wasPaused && nowPaused) pauseAll();
      else if (wasPaused && !nowPaused) resumeAll();
    },
    [pauseAll, resumeAll]
  );
  // dismiss() is defined before setPause (startTimer needs it), so it
  // reaches setPause through a ref.
  const setPauseRef = useRef(setPause);
  useEffect(() => {
    setPauseRef.current = setPause;
  }, [setPause]);

  useEffect(
    () =>
      subscribe(({ message, kind }) => {
        const list = listRef.current;
        // The same message twice (a second failed save) stays one toast —
        // unless the first is already on its way out.
        if (list.some((t) => !t.leaving && t.message === message && t.kind === kind)) return;
        const active = list.filter((t) => !t.leaving);
        if (active.length >= MAX_VISIBLE) dismiss(active[0].id);
        const id = nextId.current++;
        commit([...listRef.current, { id, message, kind, leaving: false }]);
        timers.current.set(id, { handle: null, remaining: LIFETIME_MS[kind] ?? 8000, startedAt: 0 });
        if (!isPaused(pause.current)) startTimer(id);
      }),
    [commit, dismiss, startTimer]
  );

  useEffect(() => {
    const onVisibility = () => setPause('hidden', document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [setPause]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) clearTimeout(timer.handle);
      all.clear();
    };
  }, []);

  return (
    <div
      ref={stackRef}
      className="v2-toasts"
      role="status"
      aria-live="polite"
      // Mouse only: a tap fires a synthetic hover that never ends.
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setPause('hover', true);
      }}
      onPointerLeave={() => setPause('hover', false)}
      onFocus={() => setPause('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPause('focus', false);
      }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={`v2-toast is-${t.kind}${t.leaving ? ' is-leaving' : ''}`}
          role={t.kind === 'error' ? 'alert' : undefined}
        >
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
