import { useState } from 'react';
import { getPublicCommands } from '../api.js';
import { useApiData } from '../useApiData.js';
import LoadError from '../components/LoadError.jsx';

// The reference of Sylo's slash commands. Public:
// it works without signing in and reads only /api/v2/public/commands. (Turning commands off for a
// server is the per-server Commands tab on the Moderation page, not this.)
export default function CommandList() {
  const { data, error } = useApiData(() => getPublicCommands(), []);
  const [query, setQuery] = useState('');

  if (error) return <LoadError error={error} what="the commands" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  const q = query.trim().toLowerCase();
  const shown = data.commands.filter(
    (c) => !q || c.signature.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)
  );

  return (
    <>
      <h1 className="v2-section-title">Commands</h1>
      <p className="v2-field-hint">
        Every slash command Sylo has, generated from the commands it has loaded. Use them in any server Sylo
        is in.
      </p>
      <input
        className="v2-search"
        type="search"
        placeholder="Search commands…"
        aria-label="Search commands"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.length ? (
        <div className="v2-list v2-cmdref-list">
          {shown.map((c) => (
            <div className="v2-row v2-cmdref" key={c.signature}>
              <div className="v2-row-main">
                <h3 className="v2-break">
                  <code>{c.signature}</code>
                </h3>
                {c.description ? <p className="v2-break">{c.description}</p> : null}
                {c.permissions ? (
                  <p className="v2-field-hint v2-break">Requires: {c.permissions.join(', ')}</p>
                ) : null}
                {c.options.length ? (
                  <dl className="v2-cmdref-opts">
                    {c.options.map((o) => (
                      <div key={o.name}>
                        <dt>
                          <code>{o.name}</code>
                          <span className="v2-field-hint">{o.required ? ' required' : ' optional'}</span>
                        </dt>
                        <dd className="v2-break">
                          {o.description}
                          {o.choices.length ? (
                            <span className="v2-field-hint"> Choices: {o.choices.join(', ')}</span>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="v2-state v2-break is-instant">
          {q ? `No commands match "${query.trim()}".` : 'No commands loaded yet.'}
        </p>
      )}
    </>
  );
}
