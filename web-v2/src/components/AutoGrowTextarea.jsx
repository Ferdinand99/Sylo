import { useLayoutEffect, useRef } from 'react';

/**
 * Sets a textarea's height to fit all of its text, so a long value makes the box taller instead
 * of scrolling inside it. Exported for tests; the component below calls it.
 */
export function resizeToContent(el) {
  if (!el) return;
  el.style.height = 'auto';
  // scrollHeight leaves the border out, so add it back for border-box fields (offsetHeight and
  // clientHeight both read 0 where nothing is laid out, e.g. in tests).
  const border = Math.max(0, el.offsetHeight - el.clientHeight);
  el.style.height = `${el.scrollHeight + border}px`;
}

/**
 * A <textarea> that always shows its whole value. Takes the props of a normal textarea (use it
 * instead of one wherever the text can be more than a line: embed descriptions, message text).
 * It sizes itself when it first shows, whenever `value` changes (also when the value is set from
 * outside, like an inserted variable), on input and when its width changes (text re-wraps).
 * `rows` is the minimum height (default 1).
 */
export default function AutoGrowTextarea({ value, onInput, className = '', rows = 1, ...rest }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    resizeToContent(ref.current);
  }, [value]);

  // A different width wraps the text differently: re-measure when the box is resized.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resizeToContent(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      value={value}
      className={`v2-autogrow${className ? ` ${className}` : ''}`}
      onInput={(e) => {
        resizeToContent(e.currentTarget);
        onInput?.(e);
      }}
    />
  );
}
