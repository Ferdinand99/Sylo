import { useEffect, useRef, useState } from 'react';
import { notify } from '../notify.js';

/**
 * A small "Copy" button for a value people paste elsewhere (a user ID). Shows "Copied" for a
 * moment; if the browser blocks the clipboard it says so instead. `what` names the value for
 * screen readers ("Copy user ID").
 */
export default function CopyButton({ text, what = 'value' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(text));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      notify(`Could not copy the ${what}. Select it and copy by hand.`);
    }
  }

  return (
    <button type="button" className="v2-btn-ghost v2-btn-compact" onClick={copy} aria-label={`Copy ${what}`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
