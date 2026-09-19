import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { getGuilds } from '../api.js';
import { readLastGuildId, writeLastGuildId } from '../util.js';
import { OverviewProvider } from '../OverviewContext.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import Sidebar from './Sidebar.jsx';

// Top-level layout for every V2 page: topbar (brand, server switcher — kept
// out of the sidebar per request, it's app-wide not tied to one guild page —
// and the link back to V1) plus the persistent left sidebar (Sidebar.jsx).
// Fetches the guild list once and hands it down via Outlet context so
// GuildPicker doesn't need its own separate fetch of the same list.
export default function Shell() {
  const [state, setState] = useState({ loading: true, guilds: [], error: null });
  const { guildId } = useParams();
  // The server switcher and sidebar links need a guild to point at even on
  // pages that aren't guild-scoped (Bot Personalizer, Health) — otherwise
  // navigating there loses the selection instead of just "not needing" it.
  // Seeded from localStorage so a reload/new tab remembers it too.
  const [lastGuildId, setLastGuildId] = useState(readLastGuildId);
  // Off-canvas sidebar below the 860px breakpoint (see .v2-sidebar in
  // styles.css) — above it this is unused, the sidebar is always visible.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { pathname } = useLocation();

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
      </header>
      <OverviewProvider guildId={lastGuildId}>
        <div className="v2-body">
          <Sidebar activeGuildId={lastGuildId} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
          <main className="v2-page">
            <Outlet context={{ guilds, guildsLoading: loading, guildsError: error }} />
          </main>
        </div>
      </OverviewProvider>
    </div>
  );
}
