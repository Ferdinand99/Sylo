import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../notify.js';

const LIFETIME_MS = { error: 10000, info: 5000 };

// Messages from notify(), stacked bottom-right. Each one can be dismissed and
// goes away by itself. Errors are announced to screen readers at once.
export default function Toasts() {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);

  useEffect(
    () =>
      subscribe(({ message, kind }) => {
        const id = nextId.current++;
        setItems((list) => {
          // The same message twice (a second failed save) stays one toast.
          if (list.some((t) => t.message === message && t.kind === kind)) return list;
          return [...list.slice(-3), { id, message, kind }];
        });
        setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), LIFETIME_MS[kind] ?? 8000);
      }),
    []
  );

  if (!items.length) return null;
  return (
    <div className="v2-toasts">
      {items.map((t) => (
        <div key={t.id} className={`v2-toast is-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
