import { Suspense, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import ThemeToggle from './ThemeToggle.jsx';
import Toasts from './Toasts.jsx';
import useLabelLinks from './useLabelLinks.js';
import useTheme from './useTheme.js';
import useTopbarScrolled from './useTopbarScrolled.js';

// The layout for pages meant for the members of a server rather than its admins (the web shop): the
// same topbar as the dashboard, but no server switcher, account menu or sidebar, because those are
// for people who manage servers. The visitor is signed in (the server sends everyone else to the
// login before this loads); what the page may show is decided by its own API.
export default function MemberShell() {
  useLabelLinks();
  const topbarRef = useRef(null);
  const [theme, toggleTheme] = useTheme();
  useTopbarScrolled(topbarRef);

  return (
    <div className="v2-shell v2-public">
      <header ref={topbarRef} className="v2-topbar">
        <span className="v2-brand">
          <img className="v2-brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
          <span>Sylo</span>
        </span>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>
      <main className="v2-page v2-public-page">
        <Suspense fallback={<p className="v2-state">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
      <Toasts />
    </div>
  );
}
