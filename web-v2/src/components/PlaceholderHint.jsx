import { useEffect, useRef, useState } from 'react';
import { insertAtCursor, unknownTokens } from '../placeholders.js';

const MAX_WARNINGS = 3;

/**
 * The "Insert: {user} {server} …" chips under a template field, plus a warning for any `{token}` in
 * the field that this module does not fill in. Used under every textarea or input whose text is a
 * template.
 *
 *   <textarea id="joinMessage" value={form.joinMessage} … />
 *   <PlaceholderHint fieldId="joinMessage" tokens={tokensFor('welcome', data.placeholders)}
 *     value={form.joinMessage} onChange={(joinMessage) => set({ joinMessage })} />
 *
 * `fieldId` is the id of the textarea/input the chips write into; the chips put the token where the
 * caret is (over the selection, or at the end when the field was never clicked) and give the caret
 * back to the field. Unknown tokens only warn: saving is never blocked. With `chips={false}` only the
 * warnings are drawn (the form has one shared PlaceholderBar for its chips). `tokens` are
 * `{ token, hint }` objects (see placeholders.js).
 */
export default function PlaceholderHint({
  fieldId,
  tokens,
  value,
  onChange,
  ignoreCase = false,
  chips = true,
  className = '',
}) {
  // The field's last selection, remembered when it loses focus (clicking a chip blurs it on
  // browsers that ignore the mousedown guard below).
  const lastSelection = useRef(null);
  // The token that did not fit the field's character limit, for a short note under the chips.
  const [noRoom, setNoRoom] = useState('');

  useEffect(() => {
    const el = document.getElementById(fieldId);
    if (!el) return undefined;
    const remember = () => {
      lastSelection.current = { start: el.selectionStart, end: el.selectionEnd };
    };
    el.addEventListener('blur', remember);
    return () => el.removeEventListener('blur', remember);
  }, [fieldId]);

  const insert = (token) => {
    const el = document.getElementById(fieldId);
    let start;
    let end;
    if (el && document.activeElement === el) {
      start = el.selectionStart;
      end = el.selectionEnd;
    } else if (lastSelection.current) {
      ({ start, end } = lastSelection.current);
    }
    const next = insertAtCursor(value, token, start, end);
    if (el && el.maxLength > 0 && next.value.length > el.maxLength) {
      setNoRoom(token);
      return;
    }
    setNoRoom('');
    // Typing-like insert first: the browser keeps its undo history (Ctrl+Z takes the chip back) and
    // fires the field's own input event. Falls back to setting the value where that is unsupported.
    if (el && start !== undefined && end !== undefined) {
      el.focus();
      el.setSelectionRange(start, end);
      let done;
      try {
        done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, token);
      } catch {
        done = false;
      }
      if (done) {
        lastSelection.current = { start: next.caret, end: next.caret };
        return;
      }
    }
    onChange(next.value);
    lastSelection.current = { start: next.caret, end: next.caret };
    // The new value is not in the field yet: give the caret back after React has rendered it.
    requestAnimationFrame(() => {
      const field = document.getElementById(fieldId);
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    });
  };

  const unknown = unknownTokens(value, tokens, { ignoreCase });

  return (
    <div className={`v2-ph${className ? ` ${className}` : ''}`}>
      {chips ? (
        <>
          <div className="v2-ph-chips" role="group" aria-label="Insert a placeholder">
            <span className="v2-ph-label">Insert:</span>
            {tokens.map((tk) => (
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
          <p className="v2-field-hint">Click one to insert it at the cursor.</p>
        </>
      ) : null}
      {noRoom ? (
        <p className="v2-ph-warn" role="status">
          <span aria-hidden="true">⚠ </span>
          No room for <code>{noRoom}</code>: the field is full.
        </p>
      ) : null}
      {unknown.slice(0, MAX_WARNINGS).map((u) => (
        <p className="v2-ph-warn" role="status" key={u.token}>
          <span aria-hidden="true">⚠ </span>
          <code>{u.token}</code> isn't a placeholder here
          {u.suggestion ? (
            <>
              {' '}
              — did you mean <code>{u.suggestion}</code>?
            </>
          ) : (
            <> — it will show up exactly as typed.</>
          )}
        </p>
      ))}
      {unknown.length > MAX_WARNINGS ? (
        <p className="v2-ph-warn">
          <span aria-hidden="true">⚠ </span>
          and {unknown.length - MAX_WARNINGS} more that aren't placeholders here.
        </p>
      ) : null}
    </div>
  );
}
