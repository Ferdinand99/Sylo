import { useEffect, useRef, useState } from 'react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.js';

const SAVED_MS = 2000;

/**
 * Keep the field being edited above the bar. The bar is sticky at the bottom of the window, so a field near
 * the bottom is covered by it the moment a first edit makes it appear. When the focused field sits inside a
 * settings form and its box reaches the bar's, scroll it just clear; `scroll-margin-bottom` on the fields
 * (styles/p1-polish.css) leaves the room. Exported for tests.
 * @param {Element|null} active  document.activeElement
 * @param {Element|null} bar  the bar's box
 * @returns {boolean} whether it scrolled
 */
export function keepFieldAboveBar(active, bar) {
  if (!active || !bar || !active.closest?.('form[data-savebar]')) return false;
  const field = active.getBoundingClientRect();
  const box = bar.getBoundingClientRect();
  if (field.bottom <= box.top || field.top >= box.bottom) return false;
  active.scrollIntoView?.({ block: 'nearest' });
  return true;
}
const TEXT_LIKE = new Set([
  'text',
  'search',
  'url',
  'email',
  'number',
  'tel',
  'password',
  'datetime-local',
  'date',
  'time',
]);

/**
 * Sticky bar at the bottom of the page content that appears while a form has
 * unsaved edits: "Unsaved changes · Reset · Save". After a successful save it
 * briefly reads "Saved" and fades out. Ctrl/Cmd+S saves. Also installs the
 * unsaved-changes navigation guard, so render one per page, as the page's
 * last element (outside any <form>, so it sticks for the whole page).
 *
 * Props: dirty, saving, onSave(), onReset(), saveLabel ('Save'), guard (true).
 */
export default function SaveBar({
  dirty,
  saving = false,
  onSave,
  onReset,
  saveLabel = 'Save',
  guard = true,
}) {
  const [justSaved, setJustSaved] = useState(false);
  const wasSaving = useRef(false);

  // A save that finished with the form clean = it worked.
  useEffect(() => {
    if (wasSaving.current && !saving && !dirty) setJustSaved(true);
    wasSaving.current = saving;
  }, [saving, dirty]);

  useEffect(() => {
    if (!justSaved) return undefined;
    if (dirty) {
      setJustSaved(false);
      return undefined;
    }
    const t = setTimeout(() => setJustSaved(false), SAVED_MS);
    return () => clearTimeout(t);
  }, [justSaved, dirty]);

  const barRef = useRef(null);
  const visible = dirty || saving || justSaved;
  // The bar fades in over whatever is at the bottom of the window: check the focused field when it appears,
  // and again as the person types (an auto-growing field moves down as it grows).
  useEffect(() => {
    if (!visible) return undefined;
    const check = () => keepFieldAboveBar(document.activeElement, barRef.current);
    check();
    document.addEventListener('input', check);
    document.addEventListener('focusin', check);
    return () => {
      document.removeEventListener('input', check);
      document.removeEventListener('focusin', check);
    };
  }, [visible]);

  const latest = useRef({ dirty, saving, onSave });
  latest.current = { dirty, saving, onSave };
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      // Not while a dialog (a confirm, the leave-page prompt) is in front of the form.
      if (document.querySelector('dialog[open]')) return;
      const { dirty: d, saving: s, onSave: save } = latest.current;
      if (d && !s) save?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Enter in a text field saves, as it did when each form had its own submit
  // button. Only in the page's settings form (marked data-savebar), never in a
  // row editor, a form with its own submit button, or a dialog.
  useEffect(() => {
    const onEnter = (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !TEXT_LIKE.has(el.type)) return;
      const form = el.form;
      if (!form?.hasAttribute('data-savebar') || el.closest('dialog')) return;
      if (form.querySelector('button[type="submit"], input[type="submit"]')) return;
      e.preventDefault();
      const { dirty: d, saving: s, onSave: save } = latest.current;
      if (d && !s) save?.();
    };
    document.addEventListener('keydown', onEnter);
    return () => document.removeEventListener('keydown', onEnter);
  }, []);

  return (
    <>
      {guard ? <Guard dirty={dirty} /> : null}
      <SaveBarView
        barRef={barRef}
        dirty={dirty}
        saving={saving}
        justSaved={justSaved}
        onSave={onSave}
        onReset={onReset}
        saveLabel={saveLabel}
      />
    </>
  );
}

function Guard({ dirty }) {
  useUnsavedChangesGuard(dirty);
  return null;
}

function SaveBarView({ barRef, dirty, saving, justSaved, onSave, onReset, saveLabel }) {
  const visible = dirty || saving || justSaved;
  const mode = dirty || saving ? 'dirty' : 'saved';
  return (
    <div
      ref={barRef}
      className={`v2-savebar${visible ? ' is-visible' : ''}`}
      data-mode={mode}
      inert={visible ? undefined : true}
    >
      <div className="v2-savebar-inner">
        <p className="v2-savebar-text" aria-live="polite">
          {mode === 'saved' ? (
            visible ? (
              <>
                <span className="v2-savebar-check" aria-hidden="true">
                  ✓
                </span>{' '}
                Saved
              </>
            ) : null
          ) : saving ? (
            'Saving…'
          ) : (
            'Unsaved changes'
          )}
        </p>
        <div className="v2-savebar-actions">
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={!dirty || saving}
            onClick={() => onReset?.()}
          >
            Reset
          </button>
          <button
            type="button"
            className="v2-btn-primary"
            disabled={!dirty || saving}
            onClick={() => onSave?.()}
            title="Ctrl+S / ⌘S"
          >
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
