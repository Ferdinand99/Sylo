import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Matches /guilds/:id or /guilds/:id/<subpath> — captures the subpath (or ''
// for the guild root) so switching servers on e.g. Leaderboard lands back on
// Leaderboard for the new guild, not always the Dashboard.
const GUILD_PAGE = /^\/guilds\/[^/]+(\/.*)?$/;

// Native <details>/<summary> — no JS needed for open/close, same pattern as
// the FAQ accordion on sylobot.com. `activeGuildId` is Shell's "sticky"
// selection (persists onto guild-agnostic pages like Personalizer/Health),
// not necessarily the URL's own :guildId.
export default function ServerSwitcher({ guilds, activeGuildId, onSelectGuild }) {
  const current = guilds.find((g) => g.id === activeGuildId) ?? null;
  const detailsRef = useRef(null);
  const { pathname } = useLocation();
  const guildPageMatch = pathname.match(GUILD_PAGE);
  const subpath = guildPageMatch ? (guildPageMatch[1] ?? '') : null;

  // Clicking a Link navigates but doesn't unmount this component (it's part
  // of the persistent Shell), so the native <details> would otherwise stay
  // open across the navigation — close it explicitly. Same for a click
  // outside or Escape, matching V1's equivalent (header.ejs's srv-switch,
  // Alpine's @click.outside / @keydown.escape).
  function closeMenu() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  useEffect(() => {
    function onDocClick(e) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target)) closeMenu();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <details className="v2-switch" ref={detailsRef}>
      <summary>
        {current?.icon ? (
          <img src={current.icon} alt="" />
        ) : (
          <span className="v2-switch-ph">{current ? current.name.charAt(0) : '?'}</span>
        )}
        <span className="v2-switch-name">{current ? current.name : 'Select a server'}</span>
        <span className="v2-switch-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="v2-switch-menu">
        {guilds.map((g) => {
          const inner = (
            <>
              {g.icon ? (
                <img src={g.icon} alt="" />
              ) : (
                <span className="v2-switch-dot">{g.name.charAt(0)}</span>
              )}
              <span>{g.name}</span>
            </>
          );
          const className = g.id === activeGuildId ? 'active' : '';
          // On a guild-scoped page, switch servers by navigating to the same
          // subpage for the new guild. Elsewhere (Personalizer, Health, the
          // picker) there's no guild-scoped page to jump to, so just update
          // the selection in place — no navigation.
          return subpath !== null ? (
            <Link key={g.id} to={`/guilds/${g.id}${subpath}`} className={className} onClick={closeMenu}>
              {inner}
            </Link>
          ) : (
            <button
              key={g.id}
              type="button"
              className={className}
              onClick={() => {
                onSelectGuild(g.id);
                closeMenu();
              }}
            >
              {inner}
            </button>
          );
        })}
        {!guilds.length ? <p className="v2-switch-empty">No servers found</p> : null}
      </div>
    </details>
  );
}
