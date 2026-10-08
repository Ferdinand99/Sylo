import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { getGuilds } from '../api.js';
import { readLastGuildId, writeLastGuildId, readTheme, writeTheme } from '../util.js';
import { OverviewProvider } from '../OverviewContext.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import Sidebar from './Sidebar.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Toasts from './Toasts.jsx';
import useLabelLinks from './useLabelLinks.js';

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
  const [theme, setTheme] = useState(() => readTheme() ?? 'dark');
  const { pathname } = useLocation();

  // index.html's inline script already set data-theme before first paint for
  // a saved "light" choice (avoids a flash of dark-then-light) — this just
  // keeps it in sync as the user toggles, and handles switching back to dark.
  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      writeTheme(next);
      return next;
    });
  }

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
      <header className="v2-topbar">
        <button
          type="button"
          className="v2-nav-toggle"
          aria-label="Menu"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link className="v2-brand" to="/">
          <span className="v2-brand-mark">S</span>
          <span>Sylo</span>
          <span
            className="v2-beta-badge"
            title="Not every module has a V2 page yet — some still open the classic dashboard"
          >
            Beta
          </span>
        </Link>
        <ServerSwitcher guilds={guilds} activeGuildId={lastGuildId} onSelectGuild={selectGuild} />
        <a className="v2-classic-link" href="/">
          Back to classic dashboard
        </a>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>
      <OverviewProvider guildId={lastGuildId}>
        <div className="v2-body">
          <Sidebar activeGuildId={lastGuildId} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
          <main className="v2-page">
            <Outlet context={{ guilds, guildsLoading: loading, guildsError: error }} />
          </main>
        </div>
      </OverviewProvider>
      <Toasts />
    </div>
  );
}
