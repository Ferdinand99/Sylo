import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, ScrollRestoration, useLocation, useParams } from 'react-router-dom';
import { getGuilds, getPublicSession } from '../api.js';
import { readLastGuildId, writeLastGuildId } from '../util.js';
import { isPublicPath } from '../publicRoutes.js';
import { OverviewProvider } from '../OverviewContext.jsx';
import Announcement from './Announcement.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import Sidebar from './Sidebar.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import AccountMenu from './AccountMenu.jsx';
import CommandPalette, { isApplePlatform, isPaletteShortcut } from './CommandPalette.jsx';
import { Icon } from './icons.jsx';
import PublicShell from './PublicShell.jsx';
import Toasts from './Toasts.jsx';
import useLabelLinks from './useLabelLinks.js';
import useTheme from './useTheme.js';
import useTopbarScrolled from './useTopbarScrolled.js';

// Top-level layout for every V2 page: topbar (brand, server switcher — kept
// out of the sidebar per request, it's app-wide not tied to one guild page —
// and the account menu) plus the persistent left sidebar (Sidebar.jsx).
// Fetches the guild list once and hands it down via Outlet context so
// GuildPicker doesn't need its own separate fetch of the same list.
function SignedInShell() {
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
  const topbarRef = useRef(null);
  const [theme, toggleTheme] = useTheme();
  useTopbarScrolled(topbarRef);
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl+K (⌘K on Apple devices) opens the command palette from anywhere. The palette closes itself on the
  // same keys (CommandPalette.jsx). It stays out of the way of another dialog that is already open (a
  // confirmation).
  useEffect(() => {
    function onKeyDown(e) {
      if (!isPaletteShortcut(e) || paletteOpen || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setPaletteOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen]);

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
          <img className="v2-brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
          <span>Sylo</span>
        </Link>
        <ServerSwitcher guilds={guilds} activeGuildId={lastGuildId} onSelectGuild={selectGuild} />
        <button
          type="button"
          className="v2-palette-trigger"
          aria-label="Search the dashboard"
          aria-keyshortcuts="Control+K Meta+K"
          aria-haspopup="dialog"
          onClick={() => setPaletteOpen(true)}
        >
          <Icon name="search" className="v2-palette-trigger-icon" />
          <span className="v2-palette-trigger-text">Search</span>
          <kbd className="v2-palette-trigger-key" aria-hidden="true">
            {isApplePlatform() ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
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
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          guildId={lastGuildId}
          guilds={guilds}
        />
      </OverviewProvider>
      <Toasts />
    </div>
  );
}

// The signed-in layout above for everyone, except on the two public pages (command list,
// roadmap), which also work without a session. Those ask the server once whether this visitor
// has one (a public endpoint, so no 401): the full dashboard for a signed-in person or open mode,
// the public layout otherwise. A page opened any other way is behind the login, so the visitor
// has a session and nothing needs asking.
export default function Shell() {
  const { pathname } = useLocation();
  const [viewer, setViewer] = useState(() => (isPublicPath(pathname) ? undefined : { signedIn: true }));

  useEffect(() => {
    if (viewer !== undefined) return;
    getPublicSession()
      .then(setViewer)
      .catch(() => setViewer({ signedIn: false, open: false }));
  }, [viewer]);

  let layout;
  if (viewer === undefined) layout = <p className="v2-state">Loading…</p>;
  else layout = viewer.signedIn || viewer.open ? <SignedInShell /> : <PublicShell />;

  // A new page opens at its top (a link to #something goes to that spot instead) and the browser's
  // Back returns to where the page was left. Without this the window keeps the previous page's scroll.
  return (
    <>
      <ScrollRestoration />
      {layout}
    </>
  );
}
