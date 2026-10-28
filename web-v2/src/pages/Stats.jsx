import { getStats, ApiError } from '../api.js';
import LoadError from '../components/LoadError.jsx';
import Reveal from '../components/Reveal.jsx';
import { plural } from '../components/Meta.jsx';
import { useApiData } from '../useApiData.js';

// The game-stats lookup cache for the whole instance: who looked up which player, from any
// server. Operators only (the API answers 403 otherwise). Read-only; it never calls a game API.
export default function Stats() {
  const { data, loading, error } = useApiData(getStats, []);

  if (error) {
    if (error instanceof ApiError && error.status === 403) {
      return <p className="v2-state">This page is restricted to Sylo's operators.</p>;
    }
    return <LoadError error={error} what="cached stats" />;
  }
  if (loading && !data) return <p className="v2-state">Loading…</p>;

  return (
    <Reveal>
      <h1 className="v2-section-title">Cached stats</h1>
      <p className="v2-field-hint">
        Lookups made through <code>/stats</code>, from every server. Results are cached for{' '}
        {plural(data.ttlMinutes, 'minute')}; stale rows are refreshed on the next lookup.
      </p>

      {data.rows.length === 0 ? (
        <p className="v2-state">Nothing cached yet — run /stats in Discord.</p>
      ) : (
        <div className="v2-list v2-section-gap">
          {data.rows.map((r, i) => (
            <div className="v2-row v2-row-stack" key={i}>
              <div className="v2-row-main">
                <h3 className="v2-break">
                  {r.title} — {r.username}
                </h3>
                <p>
                  {r.platform} · K/D {r.kd} · Win {r.winRate} · {r.timePlayed} · {r.ago}
                </p>
              </div>
              <span className={`v2-status-pill ${r.fresh ? 'completed' : 'pending'}`}>
                {r.fresh ? 'fresh' : 'stale'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Reveal>
  );
}
