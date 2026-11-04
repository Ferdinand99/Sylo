import { getStats, ApiError } from '../api.js';
import Badge from '../components/Badge.jsx';
import LoadError from '../components/LoadError.jsx';
import Reveal from '../components/Reveal.jsx';
import Meta, { plural } from '../components/Meta.jsx';
import { useApiData } from '../useApiData.js';

const PLATFORM_LABELS = {
  pc: 'PC',
  ps3: 'PlayStation 3',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  xbox360: 'Xbox 360',
  xboxone: 'Xbox One',
  xbsx: 'Xbox Series X|S',
};

/** "pc" -> "PC", "xboxone" -> "Xbox One"; an unknown id just gets a capital letter. */
export function platformLabel(id) {
  const s = String(id ?? '').trim();
  return PLATFORM_LABELS[s.toLowerCase()] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
}

const missing = (v) => v === null || v === undefined || v === '' || v === '—';

/** "412 h played" from whatever the game API gave: a number of seconds, "412h" or text; '' when unknown. */
export function playedLabel(value) {
  if (missing(value)) return '';
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return `${Math.round(Number(s) / 3600).toLocaleString()} h played`;
  const hours = /^(\d[\d,.]*)\s*h(?:ours?)?$/i.exec(s);
  return hours ? `${hours[1]} h played` : `${s} played`;
}

/** The facts of one cached lookup that the game has: platform, K/D, win rate, time played, age. */
export function statFacts(r) {
  return [
    platformLabel(r.platform),
    !missing(r.kd) && `K/D ${r.kd}`,
    !missing(r.winRate) && `Win ${r.winRate}`,
    playedLabel(r.timePlayed),
    r.ago,
  ];
}

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
      <h1 className="v2-section-title">Game stats cache</h1>
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
                  <Meta items={statFacts(r)} />
                </p>
              </div>
              <Badge tone={r.fresh ? 'success' : 'neutral'}>{r.fresh ? 'Fresh' : 'Stale'}</Badge>
            </div>
          ))}
        </div>
      )}
    </Reveal>
  );
}
