import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacement } from './overflowPlacement.js';

// Used until the menu can be measured (and where nothing is laid out, as in a test): a row is about 40 px.
const FALLBACK_WIDTH = 160;
const ITEM_HEIGHT = 40;
const MENU_PADDING = 12;

/**
 * A "⋯" button that opens a small menu of the less common actions of a row, so the row's buttons stay on
 * one line. Items are { label, onClick, danger?, disabled? }. It is a real menu button: Escape and a click
 * outside close it, the arrow keys move between the items, and focus goes back to the button on close
 * (also after an action).
 *
 * The menu is drawn in its own layer on the page (a portal with a fixed position), so a list with
 * `overflow: hidden` around the row never clips it, and it opens upward when there is no room below. It
 * closes when the page scrolls or the window is resized, since it would no longer sit under its button.
 *
 *   <OverflowMenu label="More actions for Golden Anchor" items={[{ label: 'Pause', onClick }, …]} />
 *
 * With `text` the button reads that word and a small arrow ("Set status ▾") instead of the "⋯": for a menu
 * that holds one kind of choice, where the word says more than the dots. `label` stays the accessible name
 * (it should start with the visible word). With `disabled` the button cannot be opened (a row that is busy).
 */
export default function OverflowMenu({ label, items, text = null, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const root = useRef(null);
  const button = useRef(null);
  const menu = useRef(null);
  const menuId = useId();

  // Where the menu goes: measured once it is on the page (hidden until then), and kept inside the window
  // on every side (see overflowPlacement.js).
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const trigger = button.current.getBoundingClientRect();
    const box = menu.current.getBoundingClientRect();
    setPlace(
      menuPlacement(
        trigger,
        {
          width: box.width || FALLBACK_WIDTH,
          height: box.height || items.length * ITEM_HEIGHT + MENU_PADDING,
        },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!root.current?.contains(e.target) && !menu.current?.contains(e.target)) setOpen(false);
    };
    const leave = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', leave, true);
      window.removeEventListener('resize', leave);
    };
  }, [open]);

  useEffect(() => {
    if (open && place)
      menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    // only when the menu has just been placed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place === null]);

  function close() {
    setOpen(false);
    setPlace(null);
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
    const entries = [...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const at = entries.indexOf(document.activeElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
    entries[next]?.focus({ preventScroll: true });
  }

  return (
    <div className="v2-overflow" ref={root}>
      <button
        ref={button}
        type="button"
        className={`v2-btn-ghost v2-overflow-button${text ? ' has-text' : ''}`}
        aria-label={label}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {text ? (
          <>
            {text} <span aria-hidden="true">▾</span>
          </>
        ) : (
          <span aria-hidden="true">⋯</span>
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              className="v2-overflow-menu"
              role="menu"
              id={menuId}
              aria-label={label}
              style={{ position: 'fixed', ...(place ?? { top: 0, left: 0, visibility: 'hidden' }) }}
              onKeyDown={onKeyDown}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`v2-overflow-item${item.danger ? ' is-danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    close();
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
