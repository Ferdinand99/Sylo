import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { getGuilds } from '../api.js';
import { readLastGuildId, writeLastGuildId, readTheme, writeTheme } from '../util.js';
import { OverviewProvider } from '../OverviewContext.jsx';
import Announcement from './Announcement.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import Sidebar from './Sidebar.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import AccountMenu from './AccountMenu.jsx';
import Toasts from './Toasts.jsx';
import useLabelLinks from './useLabelLinks.js';

// --bg-main per theme (styles.css) — what the browser chrome should match.
const THEME_COLOR = { dark: '#0b0b0d', light: '#f5f5f7' };

// Top-level layout for every V2 page: topbar (brand, server switcher — kept
// out of the sidebar per request, it's app-wide not tied to one guild page —
// and the link back to V1) plus the persistent left sidebar (Sidebar.jsx).
// Fetches the guild list once and hands it down via Outlet context so
// GuildPicker doesn't need its own separate fetch of the same list.
export default function Shell() {
  useLabelLinks();
  const [state, setState] = useState({ loading: true, guilds: [], error: null });
  const { guildId } = useParams();
  // The server switcher and sidebar links need a guild to point at even on
  // pages that aren't guild-scoped (Bot Personalizer, Health) — otherwise
  // navigating there loses the selection instead of just "not needing" it.
  // Seeded from the URL itself when the very first page loaded is already
  // guild-scoped (a bookmark, a shared link, a fresh browser with no
  // localStorage yet) — falling back to localStorage otherwise. Without the
  // guildId fallback, a direct hard-navigation to /v2/guilds/:id in a fresh
  // browser started this at null, which fed OverviewProvider a null guildId
  // and crashed the page (useApiData resolves to `data: null` with no error
  // for a null guildId, and Overview.jsx has nothing else guarding against
  // that combination).
  const [lastGuildId, setLastGuildId] = useState(() => guildId || readLastGuildId());
  // Off-canvas sidebar below the 860px breakpoint (see .v2-sidebar in
  // styles.css) — above it this is unused, the sidebar is always visible.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The drawer hands focus back here when it closes (Sidebar.jsx).
  const navToggleRef = useRef(null);
  // The topbar is transparent at the top of the page and turns to glass
  // once it scrolls (.v2-topbar.scrolled in styles.css).
  const topbarRef = useRef(null);
  const [theme, setTheme] = useState(() => readTheme() ?? 'dark');
  const { pathname } = useLocation();

  // index.html's inline script already set data-theme before first paint for
  // a saved "light" choice (avoids a flash of dark-then-light) — this just
  // keeps it in sync as the user toggles, and handles switching back to dark.
  // Also keeps the browser chrome / status bar colour (theme-color meta in
  // index.html) matched to the topbar background of the active theme.
  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? THEME_COLOR.light : THEME_COLOR.dark);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      writeTheme(next);
      return next;
    });
  }

  // One passive listener that only touches the DOM when the state flips —
  // the same approach as sylobot.com's nav (site/app.js). It writes the
  // class straight onto the element rather than through state, so scrolling
  // never re-renders the shell (and every page under it).
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
  }, []);

  useEffect(() => {
    getGuilds()
      .then((guilds) => setState({ loading: false, guilds, error: null }))
      .catch((error) => setState({ loading: false, guilds: [], error }));
  }, []);

  useEffect(() => {
    if (guildId) {
      setLastGuildId(guildId);
      writeLastGuildId(guildId);
    }
  }, [guildId]);

  // Belt-and-braces close on navigation — Sidebar's own links already close
  // it on click, this also catches back/forward and any other route change.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Picking a server from a bot-wide page (Personalizer, Health) shouldn't
  // navigate anywhere — there's no guild-scoped equivalent of those pages to
  // jump to — just update which server is "selected" everywhere else.
  function selectGuild(id) {
    setLastGuildId(id);
    writeLastGuildId(id);
  }

  const { guilds, loading, error } = state;

  return (
    <div className="v2-shell">
      <header ref={topbarRef} className="v2-topbar">
        <button
          ref={navToggleRef}
          type="button"
          className="v2-nav-toggle"
          aria-label="Menu"
          aria-expanded={mobileNavOpen}
          aria-controls="v2-sidebar"
          onClick={() => setMobileNavOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link className="v2-brand" to="/">
          <span className="v2-brand-mark">S</span>
          <span>Sylo</span>
          <span className="v2-beta-badge" title="V2 is in beta — the classic dashboard is still available">
            Beta
          </span>
        </Link>
        <ServerSwitcher guilds={guilds} activeGuildId={lastGuildId} onSelectGuild={selectGuild} />
        {/* Two labels, one shown at a time — styles.css swaps to the short
            one on narrow screens so the topbar keeps to one row. */}
        <a className="v2-classic-link" href="/?classic=1" aria-label="Back to classic dashboard">
          <span className="v2-classic-full">Back to classic dashboard</span>
          <span className="v2-classic-short">Classic</span>
        </a>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        <AccountMenu />
      </header>
      <OverviewProvider guildId={lastGuildId}>
        <div className="v2-body">
          <Sidebar
            activeGuildId={lastGuildId}
            open={mobileNavOpen}
            onClose={() => setMobileNavOpen(false)}
            returnFocusRef={navToggleRef}
          />
          <main className="v2-page">
            <Announcement />
            <Suspense fallback={<p className="v2-state">Loading…</p>}>
              <Outlet context={{ guilds, guildsLoading: loading, guildsError: error }} />
            </Suspense>
          </main>
        </div>
      </OverviewProvider>
      <Toasts />
    </div>
  );
}
