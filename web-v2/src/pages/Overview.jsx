import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { setModuleEnabled, setModulesEnabledBulk } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import { v2Href } from '../moduleForms/index.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Switch from '../components/Switch.jsx';
import { plural } from '../components/Meta.jsx';
import { formatCount, initial } from '../util.js';
import Reveal from '../components/Reveal.jsx';
import BlockedNote from '../components/BlockedNote.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { Icon } from '../components/icons.jsx';
import { attentionItems, cardSummaryParts, cardTone, problemIdsOf, TONE_LABEL } from '../overviewModel.js';
import { readCollapsed, toggled, writeCollapsed } from '../collapsedGroups.js';

// A newly-added module gets this next to its name until it's had enough
// real-world use to drop registry.js's `beta` flag.
function BetaTag() {
  return (
    <span className="v2-beta-tag" title="New module — behavior may still change">
      Beta
    </span>
  );
}

// The panel at the top: what is waiting for a person and what is switched on but not set up. Each item
// goes to the page where it is dealt with; with nothing to do the panel says so in one calm line.
function NeedsAttention({ items }) {
  if (!items.length) {
    return (
      <p className="v2-attention is-clear" role="status">
        <Icon name="shield-check" className="v2-attention-clear-icon" />
        Nothing needs your attention right now.
      </p>
    );
  }
  // The waiting work is one row of links; every other item gets its own row with what is wrong.
  const waiting = items.filter((i) => i.kind === 'waiting');
  const rest = items.filter((i) => i.kind !== 'waiting');
  return (
    <section className="v2-attention" aria-labelledby="v2-attention-title">
      <h2 id="v2-attention-title" className="v2-attention-title">
        Needs attention <span className="v2-attention-count">{items.length}</span>
      </h2>
      <ul className="v2-attention-list">
        {waiting.length ? (
          <li className="v2-attention-item is-waiting">
            <span className="v2-attention-dot" aria-hidden="true" />
            <div className="v2-attention-text">
              <strong>Waiting for a person</strong>
              <span className="v2-attention-pills">
                {waiting.map((item) => (
                  <Link key={item.key} className="v2-attention-pill" to={item.href}>
                    {item.title}
                  </Link>
                ))}
              </span>
            </div>
          </li>
        ) : null}
        {rest.map((item) => (
          <li key={item.key} className={`v2-attention-item is-${item.kind}`}>
            <span className="v2-attention-dot" aria-hidden="true" />
            <div className="v2-attention-text">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
            {item.href ? (
              <Link
                className="v2-attention-go"
                to={item.href}
                aria-label={`${item.kind === 'waiting' ? 'Open' : 'Fix'} ${item.title}`}
              >
                {item.kind === 'waiting' ? 'Open' : 'Fix'}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// One module as a card that opens its page. The title link is stretched over the whole card; the switch
// (or the bulk-edit checkbox) sits above it as the secondary control.
function ModuleRow({ card, guildId, tone, onToggle, selecting, picked, onPick }) {
  const href = v2Href(card, guildId);
  const blocked = card.missingIntents.length > 0;
  const parts = cardSummaryParts(card);
  return (
    <div className={`v2-modrow is-${tone}`}>
      <span className="v2-modrow-icon" aria-hidden="true">
        <Icon name={card.icon} className="v2-modrow-svg" />
      </span>
      <div className="v2-modrow-main">
        <Link className="v2-row-title-link v2-modrow-link" to={href}>
          <h3>
            {card.name} {card.beta ? <BetaTag /> : null}
          </h3>
        </Link>
        <p className="v2-modrow-summary" title={card.description}>
          {parts.map((part, i) => (
            <span key={i} className="v2-modrow-part">
              {part}
            </span>
          ))}
        </p>
        {blocked && card.hasToggle ? (
          <p className="v2-row-warn">
            <BlockedNote intents={card.missingIntents} />
          </p>
        ) : null}
      </div>
      {card.hasToggle ? (
        <>
          <span className={`v2-modrow-status is-${tone}`}>
            <span className="v2-modrow-dot" aria-hidden="true" />
            {TONE_LABEL[tone]}
          </span>
          {selecting ? (
            <input
              type="checkbox"
              className="v2-row-pick v2-modrow-control"
              aria-label={`Select ${card.name}`}
              checked={picked}
              onChange={(e) => onPick(card.id, e.target.checked)}
            />
          ) : (
            <span className="v2-modrow-control">
              <Switch
                checked={card.enabled}
                onChange={(on) => onToggle(card, on)}
                label={card.name}
                disabled={blocked}
              />
            </span>
          )}
        </>
      ) : (
        <span className="v2-row-arrow" aria-hidden="true">
          →
        </span>
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { data: shared, dataGuildId, error, setData } = useOverview();
  // Not the previous server's modules while this one's load.
  const data = dataGuildId === guildId ? shared : null;

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
  const attention = useMemo(() => attentionItems(data, guildId), [data, guildId]);
  const problemIds = useMemo(() => problemIdsOf(data), [data]);

  if (error) return <LoadError error={error} what="this server" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  // Optimistic: the switch flips at once, and flips back (with the error as
  // a toast) if the save fails — no disabled/dimmed flash while it saves.
  // Switching a module off asks first: it stops working for the whole server.
  async function onToggle(card, enabled) {
    const moduleId = card.id;
    if (toggling.current.has(moduleId)) return;
    if (!enabled) {
      const ok = await confirmDialog({
        title: `Switch off ${card.name}?`,
        body: 'It stops working in this server at once. Its settings are kept, so you can switch it on again later.',
        confirmLabel: 'Switch off',
        cancelLabel: 'Keep it on',
        tone: 'danger',
      });
      if (!ok) return;
    }
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
  function toggleGroup(title) {
    setCollapsed((prev) => {
      const next = toggled(prev, title);
      writeCollapsed(next);
      return next;
    });
  }
  async function applyBulk(enabled) {
    if (!picked.size || bulkBusy) return;
    if (!enabled) {
      const ok = await confirmDialog({
        title: `Switch off ${plural(picked.size, 'module')}?`,
        body: 'They stop working in this server at once. Their settings are kept.',
        confirmLabel: 'Switch off',
        cancelLabel: 'Keep them on',
        tone: 'danger',
      });
      if (!ok) return;
    }
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

  const { guild, groups } = data;
  const toggleCards = groups.flatMap((g) => g.cards).filter((c) => c.hasToggle);
  const enabledCount = toggleCards.filter((c) => c.enabled).length;
  const searching = query.trim() !== '';

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
          <p>
            {plural(guild.memberCount, 'member')} · {formatCount(enabledCount)} of{' '}
            {formatCount(toggleCards.length)} modules on
          </p>
        </div>
      </div>

      <NeedsAttention items={attention} />

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
          {selecting ? 'Cancel' : 'Bulk edit'}
        </button>
      </div>
      <p className="v2-field-hint v2-overview-hint">
        Switch a module on or off here, or open it to change its settings.
      </p>

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

      {filteredGroups.map((g) => {
        // A search shows every match, so a folded category opens while one is typed.
        const folded = collapsed.has(g.title) && !searching;
        const switches = g.cards.filter((c) => c.hasToggle);
        const listId = `v2-group-${g.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
        return (
          <section key={g.title} className={`v2-group v2-group-fold${folded ? ' is-folded' : ''}`}>
            <h2 className="v2-group-title">
              <button
                type="button"
                className="v2-group-toggle"
                aria-expanded={!folded}
                aria-controls={listId}
                onClick={() => toggleGroup(g.title)}
              >
                <Icon name="chevron" className="v2-group-chevron" />
                <span>{g.title}</span>
                {switches.length ? (
                  <span className="v2-group-count">
                    {switches.filter((c) => c.enabled).length} of {switches.length} on
                  </span>
                ) : null}
              </button>
            </h2>
            <div className="v2-list v2-modlist" id={listId} hidden={folded}>
              {g.cards.map((card) => (
                <ModuleRow
                  key={card.id}
                  card={card}
                  guildId={guildId}
                  tone={cardTone(card, problemIds)}
                  onToggle={onToggle}
                  selecting={selecting}
                  picked={picked.has(card.id)}
                  onPick={onPick}
                />
              ))}
            </div>
          </section>
        );
      })}
      {query && !filteredGroups.length ? (
        <p className="v2-state is-instant">No modules match "{query}".</p>
      ) : null}
    </Reveal>
  );
}
