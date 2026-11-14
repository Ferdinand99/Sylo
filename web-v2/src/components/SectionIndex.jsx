import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A jump list for a long page: one pill per section, each scrolling to the heading with that id. Put it
 * above the form and give each section heading an `id`:
 *
 *   <SectionIndex sections={[['eco-currency', 'Currency'], ['eco-chat', 'Earning from chat']]} />
 *   <h2 className="v2-group-title" id="eco-currency">Currency</h2>
 *
 * The row sticks under the top bar while the page scrolls, as one line that scrolls sideways on a phone,
 * and the pill of the section on screen is highlighted (`is-active`, `aria-current`). The scroll is
 * smooth unless the person asked for reduced motion; focus moves to the heading so a keyboard or screen
 * reader user lands in the section.
 */
export default function SectionIndex({ sections, label = 'On this page' }) {
  const [active, setActive] = useState(null);
  const navRef = useRef(null);

  // The height of the sticky row is published as a CSS variable, so other sticky bars (the placeholder
  // row) sit below it and the headings keep enough room above them when scrolled to.
  useLayoutEffect(() => {
    const el = navRef.current;
    const root = document.documentElement;
    if (!el) return undefined;
    const publish = () => root.style.setProperty('--sticky-index-h', `${el.offsetHeight}px`);
    publish();
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(publish);
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--sticky-index-h');
    };
  }, []);

  // The current section: the first one (in page order) whose heading is in the upper part of the window.
  const key = sections.map(([id]) => id).join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const ids = sections.map(([id]) => id);
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-120px 0px -60% 0px' }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // `key` is the content of `sections`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Keep the active pill in view inside the sideways-scrolling row.
  useEffect(() => {
    const list = navRef.current?.querySelector('ul');
    const pill = list?.querySelector('[aria-current="true"]');
    if (!list || !pill) return;
    const left = pill.offsetLeft;
    if (left < list.scrollLeft || left + pill.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - 12);
    }
  }, [active]);

  function jump(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    setActive(id);
  }
  return (
    <nav ref={navRef} className="v2-section-index" aria-label={label}>
      <span className="v2-section-index-label">Jump to</span>
      <ul>
        {sections.map(([id, text]) => (
          <li key={id}>
            <button
              type="button"
              className={`v2-section-index-pill${active === id ? ' is-active' : ''}`}
              aria-current={active === id ? 'true' : undefined}
              onClick={() => jump(id)}
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
