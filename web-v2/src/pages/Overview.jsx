import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { setModuleEnabled, setModulesEnabledBulk } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import { hasV2Page, v2Href } from '../moduleForms/index.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Switch from '../components/Switch.jsx';
import { plural } from '../components/Meta.jsx';
import { formatCount, initial } from '../util.js';
import Reveal from '../components/Reveal.jsx';

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

function ModuleRow({ card, guildId, onToggle, selecting, picked, onPick }) {
  if (!card.hasToggle) {
    const rowContent = (
      <>
        <div className="v2-row-main">
          <h3>
            {card.name} {hasV2Page(card) ? null : <ClassicTag />} {card.beta ? <BetaTag /> : null}
          </h3>
          <p title={card.description}>{card.description}</p>
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
        <p title={card.description}>{card.description}</p>
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
        <Switch
          checked={card.enabled}
          onChange={(on) => onToggle(card.id, on)}
          label={card.name}
          disabled={blocked}
        />
      )}
    </div>
  );
}

export default function Overview() {
  const { guildId } = useParams();
  const [query, setQuery] = useState('');
  // Module ids with a save in flight — a second click on the same switch
  // waits for the first to land instead of racing it.
  const toggling = useRef(new Set());
  const currentGuild = useRef(guildId);
  currentGuild.current = guildId;
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const { data, error, setData } = useOverview();

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

  if (error) return <LoadError error={error} what="this server" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  // Optimistic: the switch flips at once, and flips back (with the error as
  // a toast) if the save fails — no disabled/dimmed flash while it saves.
  async function onToggle(moduleId, enabled) {
    if (toggling.current.has(moduleId)) return;
    toggling.current.add(moduleId);
    const apply = (on) =>
      setData((d) => ({
        ...d,
        groups: d.groups.map((g) => ({
          ...g,
          cards: g.cards.map((c) => (c.id === moduleId ? { ...c, enabled: on } : c)),
        })),
      }));
    apply(enabled);
    try {
      await setModuleEnabled(guildId, moduleId, enabled);
    } catch (err) {
      // Not if the user has switched server since: the same card id there is another server's.
      if (currentGuild.current === guildId) apply(!enabled);
      notify(err.message);
    } finally {
      toggling.current.delete(moduleId);
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
    <Reveal>
      <div className="v2-hero">
        {guild.icon ? (
          <img src={guild.icon} alt="" />
        ) : (
          <div className="v2-hero-ph" aria-hidden="true">
            {initial(guild.name)}
          </div>
        )}
        <div className="v2-hero-text">
          <h1>{guild.name}</h1>
          <p>{plural(guild.memberCount, 'member')}</p>
        </div>
      </div>

      <p className="v2-note">
        <strong>V2 is in beta.</strong> Every module has its own page here now. If something looks off, the{' '}
        <a href="/">classic dashboard</a> is still available and edits the same settings.
      </p>

      <div className="v2-stat-strip">
        <div className="v2-stat">
          <strong>
            {formatCount(enabledCount)}/{formatCount(toggleCards.length)}
          </strong>
          <span>modules active</span>
        </div>
        <div className="v2-stat">
          <strong>{formatCount(openTickets)}</strong>
          <span>open {openTickets === 1 ? 'ticket' : 'tickets'}</span>
        </div>
        <div className="v2-stat">
          <strong>{formatCount(openAppeals)}</strong>
          <span>open {openAppeals === 1 ? 'appeal' : 'appeals'}</span>
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
          <span className="v2-field-hint">{formatCount(picked.size)} selected</span>
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
                onToggle={onToggle}
                selecting={selecting}
                picked={picked.has(card.id)}
                onPick={onPick}
              />
            ))}
          </div>
        </section>
      ))}
      {query && !filteredGroups.length ? (
        <p className="v2-state is-instant">No modules match "{query}".</p>
      ) : null}
    </Reveal>
  );
}
