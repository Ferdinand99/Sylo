import { useEffect, useRef, useState } from 'react';

/** Copy through a hidden textarea and execCommand: works on plain-http origins where navigator.clipboard is missing. */
function copyWithTextarea(value) {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  // select() moves focus to the textarea; put it back where it was afterwards.
  const previous = document.activeElement;
  document.body.appendChild(area);
  area.select();
  let ok;
  try {
    ok = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (previous instanceof HTMLElement && previous !== document.body) previous.focus();
  return ok;
}

/**
 * Copies `text` to the clipboard (the API where there is one, else the textarea fallback).
 * Resolves to whether it worked; for a menu item that has no button of its own to show "Copied".
 */
export async function copyText(text) {
  const value = String(text);
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch {
    ok = false;
  }
  return ok || copyWithTextarea(value);
}

/**
 * A small "Copy" button for a value people paste elsewhere (a user ID). Shows "Copied" for a
 * moment. Without the clipboard API (a plain http address) it tries a textarea fallback; if that
 * fails too, it says "Select and copy manually". The result is also announced to screen readers.
 * `what` names the value ("user ID") for the hidden part of the label.
 */
export default function CopyButton({ text, what = 'value' }) {
  const [state, setState] = useState('idle'); // idle | copied | failed
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  function show(next) {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), next === 'failed' ? 4000 : 1600);
  }

  async function copy() {
    show((await copyText(text)) ? 'copied' : 'failed');
  }

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy manually' : 'Copy';
  return (
    <>
      <button type="button" className="v2-btn-ghost v2-btn-compact" onClick={copy}>
        {label}
        {state === 'failed' ? null : (
          <>
            {' '}
            <span className="v2-sr-only">{what}</span>
          </>
        )}
      </button>
      <span className="v2-sr-only" role="status">
        {state === 'copied'
          ? `${what} copied`
          : state === 'failed'
            ? `Could not copy the ${what}. Select it and copy it by hand.`
            : ''}
      </span>
    </>
  );
}
