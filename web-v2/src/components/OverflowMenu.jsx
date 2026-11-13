import { useEffect, useId, useRef, useState } from 'react';

/**
 * A "⋯" button that opens a small menu of the less common actions of a row, so the row's buttons stay on
 * one line. Items are { label, onClick, danger?, disabled? }. It is a real menu button: Escape and a click
 * outside close it, the arrow keys move between the items, and focus goes back to the button on close.
 *
 *   <OverflowMenu label="More actions for Golden Anchor" items={[{ label: 'Pause', onClick }, …]} />
 */
export default function OverflowMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const button = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    root.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const entries = [...root.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const at = entries.indexOf(document.activeElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
    entries[next]?.focus();
  }

  return (
    <div className="v2-overflow" ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={button}
        type="button"
        className="v2-btn-ghost v2-overflow-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div className="v2-overflow-menu" role="menu" id={menuId} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`v2-overflow-item${item.danger ? ' is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
