import { Suspense, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import ThemeToggle from './ThemeToggle.jsx';
import Toasts from './Toasts.jsx';
import useLabelLinks from './useLabelLinks.js';
import useTheme from './useTheme.js';
import useTopbarScrolled from './useTopbarScrolled.js';
import { loginHref } from '../publicRoutes.js';

// The layout for the public pages (command list, roadmap) when nobody is signed in: the topbar
// with the brand, those two pages, the theme and a log-in link — no server switcher, account
// menu or sidebar, because all of those need a session. It never calls an endpoint behind the
// login, so a signed-out visitor does not get a string of 401s.
export default function PublicShell() {
  useLocation(); // re-render on navigation, so the log-in link below names the page now open
  useLabelLinks();
  const topbarRef = useRef(null);
  const [theme, toggleTheme] = useTheme();
  useTopbarScrolled(topbarRef);

  return (
    <div className="v2-shell v2-public">
      <header ref={topbarRef} className="v2-topbar">
        {/* A plain link: the dashboard home needs a login, so the server sends them there. */}
        <a className="v2-brand" href="/v2/">
          <img className="v2-brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
          <span>Sylo</span>
        </a>
        <nav className="v2-public-nav" aria-label="Public pages">
          <NavLink to="/commands">Commands</NavLink>
          <NavLink to="/roadmap">Roadmap</NavLink>
        </nav>
        <a className="v2-classic-link v2-public-login" href={loginHref()}>
          Log in
        </a>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>
      <main className="v2-page v2-public-page">
        <Suspense fallback={<p className="v2-state">Loading…</p>}>
          <Outlet context={{ guilds: [], guildsLoading: false, guildsError: null }} />
        </Suspense>
      </main>
      <Toasts />
    </div>
  );
}
