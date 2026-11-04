import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The scroll position that shows `tab` fully inside `row`, or null when it is already in view.
 * Exported for tests (jsdom has no layout); `view` is { scrollLeft, clientWidth }.
 */
export function scrollTarget(view, tab) {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  if (left >= view.scrollLeft && right <= view.scrollLeft + view.clientWidth) return null;
  return Math.max(0, left - (view.clientWidth - tab.offsetWidth) / 2);
}

/**
 * A row of tabs on a single line. When they don't fit (a phone) the row scrolls sideways, the
 * edge that has more tabs behind it fades out, and the active tab is scrolled into view. Put the
 * `.v2-tab` buttons inside as children and mark the current one with `is-active`; pass
 * `activeKey` (any value that changes with the selection) so the row follows it.
 *   <TabRow className="v2-hub-tabs" role="tablist" activeKey={tab}>…buttons…</TabRow>
 */
export default function TabRow({ activeKey, className = '', children, ...rest }) {
  const ref = useRef(null);
  const [edge, setEdge] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Keep the selected tab visible: when the page opens on a tab far to the right, and after a
  // click on a half-hidden one.
  useLayoutEffect(() => {
    const el = ref.current;
    const tab = el?.querySelector('.is-active');
    if (!el || !tab) return;
    const to = scrollTarget(el, tab);
    if (to !== null) {
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (typeof el.scrollTo === 'function') el.scrollTo({ left: to, behavior: calm ? 'auto' : 'smooth' });
      else el.scrollLeft = to;
    }
    measure();
  }, [activeKey, measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const fade = `${edge.start ? ' fade-start' : ''}${edge.end ? ' fade-end' : ''}`;
  return (
    <div
      {...rest}
      ref={ref}
      className={`v2-tabs${className ? ` ${className}` : ''}${fade}`}
      onScroll={measure}
    >
      {children}
    </div>
  );
}
