import { useLayoutEffect, useRef } from 'react';

/**
 * Sets a textarea's height to fit all of its text, so a long value makes the box taller instead
 * of scrolling inside it. Exported for tests; the component below calls it.
 */
export function resizeToContent(el) {
  if (!el) return;
  // Browsers with `field-sizing: content` (styles.css) size the box by themselves.
  if (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content')) return;
  // Measuring needs the box collapsed for a moment, which can shorten the page and make the
  // browser pull the scroll position up when it is scrolled to the bottom: put it back.
  const { scrollX, scrollY } = window;
  el.style.height = 'auto';
  // scrollHeight leaves the border out, so add it back for border-box fields (offsetHeight and
  // clientHeight both read 0 where nothing is laid out, e.g. in tests).
  const border = Math.max(0, el.offsetHeight - el.clientHeight);
  el.style.height = `${el.scrollHeight + border}px`;
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
}

/**
 * A <textarea> that always shows its whole value. Takes the props of a normal textarea (use it
 * instead of one wherever the text can be more than a line: embed descriptions, message text).
 * It sizes itself when it first shows, whenever `value` changes (also when the value is set from
 * outside, like an inserted variable) and when its width changes (text re-wraps).
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
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Resizing inside the observer callback would trigger "ResizeObserver loop" errors.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => resizeToContent(el));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      value={value}
      className={`v2-autogrow${className ? ` ${className}` : ''}`}
      onInput={(e) => {
        // A controlled box re-renders with the new value, and the layout effect above resizes it;
        // only an uncontrolled one needs it here.
        if (value === undefined) resizeToContent(e.currentTarget);
        onInput?.(e);
      }}
    />
  );
}
