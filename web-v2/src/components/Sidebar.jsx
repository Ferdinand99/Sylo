import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useOverview } from '../OverviewContext.jsx';
import { useOperator } from '../useOperator.js';
import { navModel } from '../overviewModel.js';
import { Icon } from './icons.jsx';

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

// One titled group of links. A link with no address (no server picked yet) is shown disabled; a count
// (waiting work) is drawn as a small pill.
function NavLinks({ items, pathname, onClose, title, separated = false }) {
  return (
    <div
      className={`v2-sidebar-section${separated ? ' is-separated' : ''}`}
      role={title ? 'group' : undefined}
      aria-label={title}
    >
      {title ? <div className="v2-sidebar-heading">{title}</div> : null}
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
        // A link may carry a query ("?tab=submissions"); only its path says which page is open.
        const path = it.href.split('?')[0];
        const active = pathname === path || (it.prefix && pathname.startsWith(`${path}/`));
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
            {it.count ? (
              <span className="v2-sidebar-count" aria-label={`${it.count} waiting`}>
                {it.count > 99 ? '99+' : it.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
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
  const { data: shared, dataGuildId } = useOverview();
  // Not the previous server's counts and modules while the next server loads.
  const data = dataGuildId === activeGuildId ? shared : null;
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

  // Guild-scoped links need a selected server. Without one (a fresh visit to the picker) they are
  // shown but disabled, rather than all pointing at "/".
  const operator = useOperator();
  const nav = navModel({ guildId: activeGuildId, data, operator });

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
        <NavLinks items={nav.top} pathname={pathname} onClose={onClose} />
        <NavLinks items={nav.inbox} pathname={pathname} onClose={onClose} title="Inbox" />
        <NavLinks items={nav.people} pathname={pathname} onClose={onClose} title="Members & moderation" />
        <NavLinks items={nav.server} pathname={pathname} onClose={onClose} title="Server" />

        {activeGuildId && nav.modules.length ? (
          <div className="v2-sidebar-modules">
            <div className="v2-sidebar-heading">Modules</div>
            {nav.modules.map((g) => (
              <div className="v2-sidebar-group" key={g.title}>
                <div className="v2-sidebar-group-title">{g.title}</div>
                {g.cards.map((card) => (
                  <Link
                    key={card.id}
                    to={card.href}
                    className={`v2-sidebar-sublink${pathname === card.href ? ' is-active' : ''}`}
                    aria-current={pathname === card.href ? 'page' : undefined}
                    onClick={onClose}
                  >
                    {card.name}{' '}
                    {card.beta ? (
                      <span className="v2-sidebar-beta-pill" title="New module — behavior may still change">
                        Beta
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        <NavLinks items={nav.more} pathname={pathname} onClose={onClose} title="More" separated />
        {nav.bot.length ? (
          <NavLinks items={nav.bot} pathname={pathname} onClose={onClose} title="Bot owner" />
        ) : null}
      </nav>
    </>
  );
}
