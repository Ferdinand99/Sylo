import { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// A promise-based replacement for window.confirm(): call it from anywhere —
// no provider, no context — and await the answer.
//
//   if (!(await confirmDialog({ title: 'Delete this reminder?', confirmLabel: 'Delete' }))) return;
//
// Renders a native <dialog> (showModal → real focus trap, inert page, Escape
// handling) into its own container on document.body, then removes it again.
// Focus starts on Cancel so a stray Enter never confirms a destructive action.
// `typeToConfirm` keeps the confirm button disabled until that exact text is
// typed — for wipe-everything actions.

const CLOSE_MS = 150;

function Dialog({ title, body, confirmLabel, cancelLabel, tone, typeToConfirm, onDone }) {
  const ref = useRef(null);
  const cancelRef = useRef(null);
  const settled = useRef(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const bodyId = useId();
  const inputId = useId();
  const needsTyping = typeof typeToConfirm === 'string' && typeToConfirm.length > 0;
  const canConfirm = !needsTyping || typed === typeToConfirm;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    // Next frame so the closed styles are committed and the entry transitions.
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function finish(result) {
    if (settled.current) return;
    settled.current = true;
    setOpen(false);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setTimeout(
      () => {
        ref.current?.close();
        onDone(result);
      },
      reduce ? 0 : CLOSE_MS
    );
  }

  return (
    <dialog
      ref={ref}
      className={`v2-dialog${open ? ' is-open' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      onCancel={(e) => {
        // Escape: animate out instead of the browser's instant close.
        e.preventDefault();
        finish(false);
      }}
      // Any other way the browser closes it still settles the promise.
      onClose={() => finish(false)}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog element itself, outside the panel).
        if (e.target === ref.current) finish(false);
      }}
    >
      <form
        className="v2-dialog-panel"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) finish(true);
        }}
      >
        <h2 id={titleId} className="v2-dialog-title">
          {title}
        </h2>
        {body ? (
          <div id={bodyId} className="v2-dialog-body">
            {body}
          </div>
        ) : null}
        {needsTyping ? (
          <div className="v2-dialog-type">
            <label htmlFor={inputId}>
              Type <code>{typeToConfirm}</code> to confirm
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
        <div className="v2-dialog-actions">
          <button ref={cancelRef} type="button" className="v2-btn-ghost" onClick={() => finish(false)}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className={tone === 'danger' ? 'v2-btn-danger-solid' : 'v2-btn-primary'}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Ask the user to confirm something. Resolves true on confirm, false on
 * cancel / Escape / backdrop click.
 *
 * @param {{ title: string, body?: import('react').ReactNode, confirmLabel?: string,
 *   cancelLabel?: string, tone?: 'danger' | 'default', typeToConfirm?: string }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  typeToConfirm,
} = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const container = document.createElement('div');
    container.className = 'v2-dialog-root';
    document.body.appendChild(container);
    const root = createRoot(container);
    const previouslyFocused = document.activeElement;
    const onDone = (result) => {
      resolve(result);
      // Unmount after resolve so the caller's state update isn't blocked.
      setTimeout(() => {
        root.unmount();
        container.remove();
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
      }, 0);
    };
    root.render(
      <Dialog
        title={title}
        body={body}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={tone}
        typeToConfirm={typeToConfirm}
        onDone={onDone}
      />
    );
  });
}

export default confirmDialog;
