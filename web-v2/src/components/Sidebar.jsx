import { Link, useLocation } from 'react-router-dom';
import { useOverview } from '../OverviewContext.jsx';
import { MODULE_FORMS } from '../moduleForms/index.js';

// Small inline icon set — kept self-contained rather than porting V1's full
// sprite (src/web/views/partials/header.ejs) just for these five.
const ICONS = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0Z" />
      <path d="M7 5H4a3 3 0 0 0 3 5M17 5h3a3 3 0 0 1-3 5" />
    </>
  ),
  id: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M15 8h3M15 12h3M6 16h12" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10.6H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </>
  ),
  pulse: <path d="M3 12h4l3 8 4-16 3 8h4" />,
};

function Icon({ name }) {
  return (
    <svg
      className="v2-sidebar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

// `open`/`onClose` only matter below the 860px breakpoint, where the
// sidebar becomes an off-canvas drawer (see Shell.jsx, which owns the open
// state and renders the hamburger button + scrim) — above it the sidebar is
// always visible and these are unused.
export default function Sidebar({ activeGuildId, open, onClose }) {
  const { pathname } = useLocation();
  // Same overview data the Dashboard page reads (OverviewContext, provided
  // in Shell.jsx) — not a separate fetch, so toggling a module there is
  // reflected here immediately, no refresh needed.
  const { data } = useOverview();

  const items = [
    {
      key: 'dashboard',
      label: 'Dashboard',
      icon: 'grid',
      href: activeGuildId ? `/guilds/${activeGuildId}` : '/',
    },
    {
      key: 'leaderboard',
      label: 'Leaderboard',
      icon: 'trophy',
      href: activeGuildId ? `/guilds/${activeGuildId}/leaderboard` : '/',
    },
    { key: 'personalizer', label: 'Bot Personalizer', icon: 'id', href: '/settings' },
    {
      key: 'settings',
      label: 'Settings',
      icon: 'gear',
      href: activeGuildId ? `/guilds/${activeGuildId}/settings` : '/',
    },
    { key: 'health', label: 'Health', icon: 'pulse', href: '/health' },
  ];

  // Only modules actually turned on for this server, grouped the same way
  // the Dashboard page groups them. A module gets enabled from there, not
  // from here — this list just reflects that state, it never toggles it.
  const moduleGroups = (data?.groups ?? [])
    .map((g) => ({ title: g.title, cards: g.cards.filter((c) => !c.hasToggle || c.enabled) }))
    .filter((g) => g.cards.length > 0);

  return (
    <>
      {open ? <button type="button" className="v2-scrim" aria-label="Close menu" onClick={onClose} /> : null}
      <nav className={`v2-sidebar${open ? ' is-open' : ''}`} aria-label="Dashboard">
        {items.map((it) => (
          <Link
            key={it.key}
            to={it.href}
            className={`v2-sidebar-link${pathname === it.href ? ' is-active' : ''}`}
            onClick={onClose}
          >
            <Icon name={it.icon} />
            <span>{it.label}</span>
          </Link>
        ))}

        {activeGuildId && moduleGroups.length ? (
          <div className="v2-sidebar-modules">
            {moduleGroups.map((g) => (
              <div className="v2-sidebar-group" key={g.title}>
                <div className="v2-sidebar-group-title">{g.title}</div>
                {g.cards.map((card) => {
                  const isV2 = Boolean(MODULE_FORMS[card.id]);
                  const href = isV2 ? `/guilds/${activeGuildId}/m/${card.id}` : card.href;
                  return isV2 ? (
                    <Link
                      key={card.id}
                      to={href}
                      className={`v2-sidebar-sublink${pathname === href ? ' is-active' : ''}`}
                      onClick={onClose}
                    >
                      {card.name}
                    </Link>
                  ) : (
                    <a
                      key={card.id}
                      href={href}
                      className="v2-sidebar-sublink"
                      onClick={onClose}
                      title="Opens the classic V1 dashboard — no V2 page yet"
                    >
                      {card.name} <span className="v2-sidebar-classic-mark">↗</span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </nav>
    </>
  );
}
