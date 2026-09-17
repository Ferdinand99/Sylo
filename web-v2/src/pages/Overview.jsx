import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getOverview, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

function ModuleRow({ card }) {
  return (
    <div className="v2-row">
      <div className="v2-row-main">
        <h3>{card.name}</h3>
        <p>{card.description}</p>
      </div>
      {card.hasToggle ? (
        <span
          className={`v2-toggle${card.enabled ? ' is-on' : ''}`}
          aria-label={card.enabled ? 'Enabled' : 'Disabled'}
        />
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
  const { data, loading, error } = useApiData(() => getOverview(guildId), [guildId]);

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

      <input
        className="v2-search"
        type="search"
        placeholder="Search modules…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search modules"
      />

      {filteredGroups.map((g) => (
        <section key={g.title} className="v2-group">
          <h2 className="v2-group-title">{g.title}</h2>
          <div className="v2-list">
            {g.cards.map((card) => (
              <ModuleRow key={card.id} card={card} />
            ))}
          </div>
        </section>
      ))}
      {query && !filteredGroups.length ? <p className="v2-state">No modules match "{query}".</p> : null}
    </>
  );
}
