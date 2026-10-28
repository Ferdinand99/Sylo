import { useEffect } from 'react';

// The topbar is transparent at the top of the page and turns to glass
// once it scrolls (.v2-topbar.scrolled in styles.css).
//
// One passive listener that only touches the DOM when the state flips —
// the same approach as sylobot.com's nav (site/app.js). It writes the
// class straight onto the element rather than through state, so scrolling
// never re-renders the shell (and every page under it).
export default function useTopbarScrolled(topbarRef) {
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return undefined;
    let scrolled = false;
    function sync() {
      const next = window.scrollY > 8;
      if (next !== scrolled) {
        scrolled = next;
        el.classList.toggle('scrolled', next);
      }
    }
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    return () => window.removeEventListener('scroll', sync);
  }, [topbarRef]);
}
