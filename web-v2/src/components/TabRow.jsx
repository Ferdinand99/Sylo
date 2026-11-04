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
 * Which tab an arrow key moves focus to, or null for any other key. Left/Right wrap around;
 * Home and End jump to the ends.
 */
export function nextTabIndex(key, tabs, current) {
  const at = tabs.indexOf(current);
  if (at === -1) return null;
  if (key === 'ArrowRight') return (at + 1) % tabs.length;
  if (key === 'ArrowLeft') return (at - 1 + tabs.length) % tabs.length;
  if (key === 'Home') return 0;
  if (key === 'End') return tabs.length - 1;
  return null;
}

/**
 * A row of tabs on a single line. When they don't fit (a phone) the row scrolls sideways, the
 * edge that has more tabs behind it fades out, and the active tab is scrolled into view. Put the
 * `.v2-tab` buttons inside as children and mark the current one with `is-active`; pass
 * `activeKey` (any value that changes with the selection) so the row follows it. Tabs are
 * keyboard-operable as a tab list: only the active one is a Tab stop, the arrow keys / Home / End
 * move focus between them, Enter or Space picks one; `panelId` is the id of the tab panel, which
 * the active tab then points to with aria-controls.
 *   <TabRow className="v2-hub-tabs" role="tablist" activeKey={tab}>…buttons…</TabRow>
 */
export default function TabRow({ activeKey, panelId, className = '', children, onKeyDown, ...rest }) {
  const ref = useRef(null);
  const [edge, setEdge] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // After every render: the tabs may have changed width (a "(off)" suffix arriving) without the
  // row itself being resized, which the observer below would never see. Also the roving
  // tabindex: only the active tab is in the Tab order, the arrow keys move between the others.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const tab of el.querySelectorAll('[role="tab"]')) {
      const active = tab.classList.contains('is-active');
      tab.tabIndex = active ? 0 : -1;
      if (panelId) {
        if (active) tab.setAttribute('aria-controls', panelId);
        else tab.removeAttribute('aria-controls');
      }
    }
    measure();
  });

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
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const next = nextTabIndex(e.key, [...e.currentTarget.querySelectorAll('[role="tab"]')], e.target);
        if (next === null) return;
        e.preventDefault();
        const tabs = e.currentTarget.querySelectorAll('[role="tab"]');
        tabs[next].focus();
        tabs[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }}
    >
      {children}
    </div>
  );
}
