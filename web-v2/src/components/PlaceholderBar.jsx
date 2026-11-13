import { useEffect, useRef, useState } from 'react';
import { insertAtCursor } from '../placeholders.js';

/**
 * Put `token` into the text field `el` where its caret is (over the selection). Typing-like first, so the
 * browser keeps its undo history and fires the field's own input event; where that is not supported the
 * value is set directly and the same event is fired, so a controlled field follows either way.
 * Returns false when the token does not fit the field's character limit.
 */
export function insertIntoField(el, token, selection) {
  const start = selection?.start ?? el.selectionStart ?? el.value.length;
  const end = selection?.end ?? el.selectionEnd ?? start;
  const next = insertAtCursor(el.value, token, start, end);
  if (el.maxLength > 0 && next.value.length > el.maxLength) return false;
  el.focus();
  el.setSelectionRange(start, end);
  let done;
  try {
    done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, token);
  } catch {
    done = false;
  }
  if (!done) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.setSelectionRange(next.caret, next.caret);
  }
  return true;
}

/**
 * One row of placeholder chips for a whole form that has several message fields, instead of the same
 * chips under every field. A chip goes into the field the person edited last (the first one until they
 * have clicked into another), and the row says which. Each field still warns about a `{token}` it does not
 * fill in (PlaceholderHint with `chips={false}`).
 *
 *   <PlaceholderBar fields={[{ id: 'joinMessage', label: 'Welcome message', tokens }, …]} />
 */
export default function PlaceholderBar({ fields }) {
  const [targetId, setTargetId] = useState(fields[0]?.id);
  const lastSelection = useRef(new Map());
  const [noRoom, setNoRoom] = useState('');

  useEffect(() => {
    const ids = new Set(fields.map((f) => f.id));
    const onFocus = (e) => {
      if (ids.has(e.target.id)) setTargetId(e.target.id);
    };
    const onBlur = (e) => {
      if (ids.has(e.target.id)) {
        lastSelection.current.set(e.target.id, {
          start: e.target.selectionStart,
          end: e.target.selectionEnd,
        });
      }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
    };
  }, [fields]);

  const target = fields.find((f) => f.id === targetId) ?? fields[0];
  if (!target) return null;

  function insert(token) {
    const el = document.getElementById(target.id);
    if (!el) return;
    const sel = document.activeElement === el ? undefined : lastSelection.current.get(target.id);
    const ok = insertIntoField(el, token, sel);
    setNoRoom(ok ? '' : token);
  }

  return (
    <div className="v2-ph v2-ph-bar">
      <div className="v2-ph-chips" role="group" aria-label="Insert a placeholder">
        <span className="v2-ph-label">Insert into “{target.label}”:</span>
        {target.tokens.map((tk) => (
          <button
            type="button"
            key={tk.token}
            title={tk.hint || undefined}
            aria-label={`Insert ${tk.token}`}
            // Keep the focus (and the caret) in the field while the chip is pressed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(tk.token)}
          >
            {tk.token}
          </button>
        ))}
      </div>
      <p className="v2-field-hint">
        Click into a message field, then click a placeholder to insert it there.
      </p>
      {noRoom ? (
        <p className="v2-ph-warn" role="status">
          <span aria-hidden="true">⚠ </span>
          No room for <code>{noRoom}</code>: the field is full.
        </p>
      ) : null}
    </div>
  );
}
