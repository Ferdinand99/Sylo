import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useOverview } from '../OverviewContext.jsx';
import { hasV2Page, v2Href } from '../moduleForms/index.js';

// Small inline icon set — kept self-contained rather than porting V1's full
// sprite (src/web/views/partials/header.ejs) just for the sidebar.
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
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  megaphone: (
    <>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  inbox: (
    <>
      <path d="M3 13 6 4h12l3 9v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h12l-2 4 2 4H5" />,
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

// Below this width the sidebar is an off-canvas drawer (styles.css).
const DRAWER_QUERY = '(max-width: 860px)';
function subscribeDrawerQuery(onChange) {
  const mq = window.matchMedia(DRAWER_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
function isDrawerLayout() {
  return window.matchMedia(DRAWER_QUERY).matches;
}

// `open`/`onClose` only matter below the 860px breakpoint, where the
// sidebar becomes an off-canvas drawer (Shell.jsx owns the open state and
// the hamburger button, passed in as `returnFocusRef`) — above it the
// sidebar is always visible and these are unused. As a drawer it behaves
// like a modal: focus moves into it on open and back to the hamburger on
// close, Escape closes it, the page behind doesn't scroll, and while closed
// it's `inert` so Tab can't wander into the off-screen links.
export default function Sidebar({ activeGuildId, open, onClose, returnFocusRef }) {
  const { pathname } = useLocation();
  // Same overview data the Dashboard page reads (OverviewContext, provided
  // in Shell.jsx) — not a separate fetch, so toggling a module there is
  // reflected here immediately, no refresh needed.
  const { data } = useOverview();
  const navRef = useRef(null);
  const isDrawer = useSyncExternalStore(subscribeDrawerQuery, isDrawerLayout);
  const drawerOpen = isDrawer && open;

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, onClose]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const toggle = returnFocusRef?.current;
    navRef.current?.querySelector('a[href]')?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      toggle?.focus({ preventScroll: true });
    };
  }, [drawerOpen, returnFocusRef]);

  // Guild-scoped links need a selected server. Without one (a fresh visit
  // to the picker) they're shown but disabled, rather than all pointing at
  // "/" — which also marked every one of them active on the picker page.
  const guildBase = activeGuildId ? `/guilds/${activeGuildId}` : null;
  const items = [
    { key: 'dashboard', label: 'Dashboard', icon: 'grid', path: '', guild: true },
    { key: 'leaderboard', label: 'Leaderboard', icon: 'trophy', path: '/leaderboard', guild: true },
    {
      key: 'moderation',
      label: 'Moderation',
      icon: 'shield',
      path: '/moderation',
      guild: true,
      prefix: true,
    },
    { key: 'tickets', label: 'Tickets', icon: 'inbox', path: '/tickets', guild: true, prefix: true },
    { key: 'appeals', label: 'Appeals', icon: 'flag', path: '/appeals', guild: true, prefix: true },
    { key: 'personalizer', label: 'Bot Personalizer', icon: 'id', path: '/settings' },
    { key: 'settings', label: 'Settings', icon: 'gear', path: '/settings', guild: true },
    { key: 'roadmap', label: 'Roadmap', icon: 'megaphone', path: '/roadmap' },
    { key: 'health', label: 'Health', icon: 'pulse', path: '/health' },
    { key: 'stats', label: 'Stats', icon: 'chart', path: '/stats' },
  ].map((it) => ({ ...it, href: it.guild ? (guildBase ? `${guildBase}${it.path}` : null) : it.path }));

  // Only modules actually turned on for this server, grouped the same way
  // the Dashboard page groups them. A module gets enabled from there, not
  // from here — this list just reflects that state, it never toggles it.
  const moduleGroups = (data?.groups ?? [])
    .map((g) => ({ title: g.title, cards: g.cards.filter((c) => !c.hasToggle || c.enabled) }))
    .filter((g) => g.cards.length > 0);

  return (
    <>
      {/* Always rendered so it can fade out as well as in; hidden (and out
          of the accessibility tree) via visibility while closed. */}
      <button
        type="button"
        className={`v2-scrim${drawerOpen ? ' is-open' : ''}`}
        aria-label="Close menu"
        tabIndex={-1}
        onClick={onClose}
      />
      <nav
        id="v2-sidebar"
        ref={navRef}
        className={`v2-sidebar${open ? ' is-open' : ''}`}
        aria-label="Dashboard"
        inert={isDrawer && !open}
      >
        {items.map((it) => {
          if (!it.href) {
            return (
              <a
                key={it.key}
                role="link"
                aria-disabled="true"
                className="v2-sidebar-link is-disabled"
                title="Pick a server first"
              >
                <Icon name={it.icon} />
                <span>{it.label}</span>
              </a>
            );
          }
          const active = pathname === it.href || (it.prefix && pathname.startsWith(`${it.href}/`));
          return (
            <Link
              key={it.key}
              to={it.href}
              className={`v2-sidebar-link${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={onClose}
            >
              <Icon name={it.icon} />
              <span>{it.label}</span>
            </Link>
          );
        })}

        {activeGuildId && moduleGroups.length ? (
          <div className="v2-sidebar-modules">
            {moduleGroups.map((g) => (
              <div className="v2-sidebar-group" key={g.title}>
                <div className="v2-sidebar-group-title">{g.title}</div>
                {g.cards.map((card) => {
                  const isV2 = hasV2Page(card);
                  const href = isV2 ? v2Href(card, activeGuildId) : card.href;
                  return isV2 ? (
                    <Link
                      key={card.id}
                      to={href}
                      className={`v2-sidebar-sublink${pathname === href ? ' is-active' : ''}`}
                      aria-current={pathname === href ? 'page' : undefined}
                      onClick={onClose}
                    >
                      {card.name}{' '}
                      {card.beta ? (
                        <span className="v2-sidebar-beta-mark" title="New module — behavior may still change">
                          ●
                        </span>
                      ) : null}
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
                      {card.beta ? (
                        <span className="v2-sidebar-beta-mark" title="New module — behavior may still change">
                          {' '}
                          ●
                        </span>
                      ) : null}
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
