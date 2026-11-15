import { useState } from 'react';

/**
 * For a form of repeatable cards with one preview: which card the person edited last, so the preview
 * follows them instead of always showing the first card. `focusProps(key)` goes on the card (React's
 * onFocus bubbles from the fields inside it); `focusedKey` is null until a card has been touched, and
 * the caller falls back to the first one.
 *
 *   const [focusedKey, focusProps] = useFocusedKey();
 *   <div className="v2-rule-card" {...focusProps(a.key)}>
 */
export function useFocusedKey() {
  const [focusedKey, setFocusedKey] = useState(null);
  return [focusedKey, (key) => ({ onFocus: () => setFocusedKey(key) })];
}

/** The card with the key, or the first card. */
export function focusedRow(rows, key) {
  return rows.find((r) => r.key === key) ?? rows[0];
}
