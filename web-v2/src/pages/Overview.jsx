import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { setModuleEnabled, setModulesEnabledBulk, ApiError } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import { hasV2Page, v2Href } from '../moduleForms/index.js';
import { notify } from '../notify.js';

// A module without a V2 page yet gets this tag next to its name, wherever
// its title is shown — the click still works (falls back to `card.href`,
// V1's own config page for it), just not as a V2-native page yet.
function ClassicTag() {
  return (
    <span className="v2-classic-tag" title="Opens the classic V1 dashboard — no V2 page yet">
      Classic
    </span>
  );
}

// A newly-added module gets this next to its name until it's had enough
// real-world use to drop registry.js's `beta` flag.
function BetaTag() {
  return (
    <span className="v2-beta-tag" title="New module — behavior may still change">
      Beta
    </span>
  );
}

// The module's name links to its V2 settings page if one's been built,
// otherwise to V1's own config page for it — `card.href`, which the
// overview API already provides (src/web/lib/overviewSummary.js). Every
// module is configurable today either way; not every one has a V2 page yet.
function ModuleTitle({ card, guildId }) {
  if (hasV2Page(card)) {
    return (
      <Link className="v2-row-title-link" to={v2Href(card, guildId)}>
        <h3>
          {card.name} {card.beta ? <BetaTag /> : null}
        </h3>
      </Link>
    );
  }
  return (
    <a className="v2-row-title-link" href={card.href}>
      <h3>
        {card.name} <ClassicTag /> {card.beta ? <BetaTag /> : null}
      </h3>
    </a>
  );
}

function ModuleRow({ card, guildId, busy, onToggle, selecting, picked, onPick }) {
  if (!card.hasToggle) {
    const rowContent = (
      <>
        <div className="v2-row-main">
          <h3>
            {card.name} {hasV2Page(card) ? null : <ClassicTag />} {card.beta ? <BetaTag /> : null}
          </h3>
          <p>{card.description}</p>
        </div>
        <span className="v2-row-arrow" aria-hidden="true">
          →
        </span>
      </>
    );
    return hasV2Page(card) ? (
      <Link className="v2-row" to={v2Href(card, guildId)}>
        {rowContent}
      </Link>
    ) : (
      <a className="v2-row" href={card.href}>
        {rowContent}
      </a>
    );
  }

  const blocked = card.missingIntents.length > 0;

  return (
    <div className="v2-row">
      <div className="v2-row-main">
        <ModuleTitle card={card} guildId={guildId} />
        <p>{card.description}</p>
        {blocked ? (
          <p className="v2-row-warn">
            Needs the {card.missingIntents.join(', ')} intent — see docs/self-hosting.md.
          </p>
        ) : null}
      </div>
      {selecting ? (
        <input
          type="checkbox"
          className="v2-row-pick"
          aria-label={`Select ${card.name}`}
          checked={picked}
          onChange={(e) => onPick(card.id, e.target.checked)}
        />
      ) : (
        <button
          type="button"
          className={`v2-toggle${card.enabled ? ' is-on' : ''}`}
          aria-label={card.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          disabled={busy || blocked}
          onClick={() => onToggle(card.id, !card.enabled)}
        />
      )}
    </div>
  );
}

export default function Overview() {
  const { guildId } = useParams();
  const [query, setQuery] = useState('');
  const [togglingId, setTogglingId] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const { data, loading, error, setData } = useOverview();

  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.groups;
    return data.groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter(
          (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.cards.length);
  }, [data, query]);

  if (loading && !data) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load this server (${error.message}).`
        )}
      </p>
    );
  }

  async function onToggle(moduleId, enabled) {
    setTogglingId(moduleId);
    try {
      await setModuleEnabled(guildId, moduleId, enabled);
      setData((d) => ({
        ...d,
        groups: d.groups.map((g) => ({
          ...g,
          cards: g.cards.map((c) => (c.id === moduleId ? { ...c, enabled } : c)),
        })),
      }));
    } catch (err) {
      notify(err.message);
    } finally {
      setTogglingId(null);
    }
  }

  function toggleSelecting() {
    setSelecting((s) => !s);
    setPicked(new Set());
  }
  function onPick(moduleId, on) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(moduleId);
      else next.delete(moduleId);
      return next;
    });
  }
  async function applyBulk(enabled) {
    if (!picked.size || bulkBusy) return;
    setBulkBusy(true);
    try {
      const ids = [...picked];
      await setModulesEnabledBulk(guildId, ids, enabled);
      setData((d) => ({
        ...d,
        groups: d.groups.map((g) => ({
          ...g,
          cards: g.cards.map((c) => (ids.includes(c.id) ? { ...c, enabled } : c)),
        })),
      }));
      setSelecting(false);
      setPicked(new Set());
    } catch (err) {
      notify(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  const { guild, groups, openTickets, openAppeals } = data;
  const toggleCards = groups.flatMap((g) => g.cards).filter((c) => c.hasToggle);
  const enabledCount = toggleCards.filter((c) => c.enabled).length;

  return (
    <>
      <div className="v2-hero">
        {guild.icon ? (
          <img src={guild.icon} alt="" />
        ) : (
          <div className="v2-hero-ph">{guild.name.charAt(0)}</div>
        )}
        <div>
          <h1>{guild.name}</h1>
          <p>{guild.memberCount.toLocaleString()} members</p>
        </div>
      </div>

      <p className="v2-note">
        <strong>V2 is in beta.</strong> Not every module has its own V2 page yet — those marked{' '}
        <span className="v2-classic-tag">Classic</span> still open the classic dashboard when clicked.
        Everything is fully configurable either way.
      </p>

      <div className="v2-stat-strip">
        <div className="v2-stat">
          <strong>
            {enabledCount}/{toggleCards.length}
          </strong>
          <span>modules active</span>
        </div>
        <div className="v2-stat">
          <strong>{openTickets}</strong>
          <span>open tickets</span>
        </div>
        <div className="v2-stat">
          <strong>{openAppeals}</strong>
          <span>open appeals</span>
        </div>
      </div>

      <div className="v2-field-row v2-search-row">
        <input
          className="v2-search"
          type="search"
          placeholder="Search modules…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search modules"
        />
        <button type="button" className="v2-btn-ghost" onClick={toggleSelecting}>
          {selecting ? 'Cancel' : 'Select'}
        </button>
      </div>

      {selecting ? (
        <div className="v2-bulk-bar">
          <span className="v2-field-hint">{picked.size} selected</span>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={!picked.size || bulkBusy}
            onClick={() => applyBulk(true)}
          >
            {bulkBusy ? 'Working…' : 'Enable'}
          </button>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={!picked.size || bulkBusy}
            onClick={() => applyBulk(false)}
          >
            {bulkBusy ? 'Working…' : 'Disable'}
          </button>
        </div>
      ) : null}

      {filteredGroups.map((g) => (
        <section key={g.title} className="v2-group">
          <h2 className="v2-group-title">{g.title}</h2>
          <div className="v2-list">
            {g.cards.map((card) => (
              <ModuleRow
                key={card.id}
                card={card}
                guildId={guildId}
                busy={togglingId === card.id}
                onToggle={onToggle}
                selecting={selecting}
                picked={picked.has(card.id)}
                onPick={onPick}
              />
            ))}
          </div>
        </section>
      ))}
      {query && !filteredGroups.length ? <p className="v2-state">No modules match "{query}".</p> : null}
    </>
  );
}
