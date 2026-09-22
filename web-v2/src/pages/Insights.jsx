import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getInsights, refreshInsights, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

// Same hand-rolled SVG bar/line chart math as V1's insights.ejs, ported
// 1:1 rather than pulling in a charting library for six small sparkline-
// style charts.
const W = 600;
const H = 120;
const PAD = 4;

function niceMax(v) {
  return v <= 0 ? 1 : v;
}

function bars(series, key) {
  const n = series.length || 1;
  const bandW = W / n;
  const max = niceMax(Math.max(0, ...series.map((d) => d[key])));
  return series.map((d, i) => {
    const h = (d[key] / max) * (H - PAD * 2);
    const x = i * bandW + Math.max(0.5, bandW * 0.12);
    const w = Math.max(1, bandW * 0.76);
    return { x, y: H - PAD - h, width: w, height: Math.max(0, h) };
  });
}

function line(series, key, keys) {
  const n = series.length || 1;
  const bandW = W / n;
  const max = niceMax(Math.max(0, ...series.map((d) => Math.max(...keys.map((k) => d[k])))));
  return series
    .map((d, i) => {
      const x = i * bandW + bandW / 2;
      const y = H - PAD - (d[key] / max) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function growthLine(series) {
  const n = series.length || 1;
  const bandW = W / n;
  let run = 0;
  const vals = series.map((d) => (run += d.joins - d.leaves));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const pts = vals
    .map((v, i) => {
      const x = i * bandW + bandW / 2;
      const y = H - PAD - ((v - lo) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return { pts, end: vals.length ? vals[vals.length - 1] : 0 };
}

function fmtDuration(minsRaw) {
  const mins = Math.round(minsRaw || 0);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h.toLocaleString('en')} h${mins % 60 ? ` ${mins % 60} m` : ''}`;
}

const RANGES = [
  ['24', 'Last 24 hours'],
  ['48', 'Last 48 hours'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
];

export default function Insights() {
  const { guildId } = useParams();
  const [range, setRange] = useState('30');
  const { data, loading, error, setData } = useApiData(() => getInsights(guildId, range), [guildId, range]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => setRange('30'), [guildId]);

  if ((loading && !data) || !data) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Server insights (${error.message}).`
        )}
      </p>
    );
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refreshInsights(guildId);
      const fresh = await getInsights(guildId, range);
      setData(fresh);
    } catch (err) {
      alert(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  const { series, totals, topChannels, topVoice } = data;
  const g = growthLine(series);
  const topMsgMax = topChannels.length ? Math.max(...topChannels.map((c) => c.messages)) : 1;
  const topVoiceMax = topVoice.length ? Math.max(...topVoice.map((c) => c.minutes)) : 1;
  const perLabel = `per ${data.granularity}`;
  const windowLabel = `last ${data.range} ${data.granularity}${data.range === 1 ? '' : 's'}`;

  return (
    <>
      <h1 className="v2-section-title">Server insights</h1>

      <div className="v2-ins-range">
        {RANGES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`v2-pill${range === value ? ' is-on' : ''}`}
            onClick={() => setRange(value)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="v2-btn-ghost v2-ins-refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh now'}
        </button>
      </div>
      <p className="v2-field-hint">
        Buffered activity is written every ~10 minutes; use Refresh now to pull the last few minutes
        immediately.
      </p>

      <div className="v2-ins-tiles">
        <div className="v2-ins-tile">
          <span className="v2-ins-n">{totals.messages.toLocaleString('en')}</span>
          <span className="v2-field-hint">messages</span>
        </div>
        <div className="v2-ins-tile">
          <span className="v2-ins-n">
            {totals.net >= 0 ? '+' : ''}
            {totals.net}
          </span>
          <span className="v2-field-hint">net members</span>
        </div>
        <div className="v2-ins-tile">
          <span className="v2-ins-n v2-ins-ok">{totals.joins}</span>
          <span className="v2-field-hint">joins</span>
        </div>
        <div className="v2-ins-tile">
          <span className="v2-ins-n v2-ins-bad">{totals.leaves}</span>
          <span className="v2-field-hint">leaves</span>
        </div>
        <div className="v2-ins-tile">
          <span className="v2-ins-n">{fmtDuration(totals.voiceMinutes)}</span>
          <span className="v2-field-hint">in voice</span>
        </div>
        <div className="v2-ins-tile">
          <span className="v2-ins-n">{totals.voicePeak}</span>
          <span className="v2-field-hint">peak in voice</span>
        </div>
      </div>

      <div className="v2-ins-grid">
        <section className="v2-ins-chart">
          <h3>Messages {perLabel}</h3>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Messages ${perLabel}`}
          >
            {bars(series, 'messages').map((b, i) => (
              <rect
                key={i}
                className="v2-ins-bar-msg"
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                rx="1"
              />
            ))}
          </svg>
        </section>

        <section className="v2-ins-chart">
          <h3>Voice minutes {perLabel}</h3>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Voice minutes ${perLabel}`}
          >
            {bars(series, 'voiceMinutes').map((b, i) => (
              <rect
                key={i}
                className="v2-ins-bar-voice"
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                rx="1"
              />
            ))}
          </svg>
        </section>

        <section className="v2-ins-chart">
          <h3>
            Member growth{' '}
            <span className="v2-field-hint">
              (cumulative, {g.end >= 0 ? '+' : ''}
              {g.end} over range)
            </span>
          </h3>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Cumulative member growth"
          >
            <polyline className="v2-ins-line-grow" fill="none" points={g.pts} />
          </svg>
        </section>

        <section className="v2-ins-chart">
          <h3>Joins vs leaves</h3>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Joins versus leaves ${perLabel}`}
          >
            <polyline
              className="v2-ins-line-join"
              fill="none"
              points={line(series, 'joins', ['joins', 'leaves'])}
            />
            <polyline
              className="v2-ins-line-leave"
              fill="none"
              points={line(series, 'leaves', ['joins', 'leaves'])}
            />
          </svg>
          <p className="v2-field-hint">
            <span className="v2-ins-key v2-ins-ok">▮</span> joins{' '}
            <span className="v2-ins-key v2-ins-bad">▮</span> leaves
          </p>
        </section>

        <section className="v2-ins-chart">
          <h3>
            Top channels <span className="v2-field-hint">({windowLabel})</span>
          </h3>
          {topChannels.length === 0 ? (
            <p className="v2-field-hint">No message activity recorded yet.</p>
          ) : (
            <ul className="v2-ins-bars">
              {topChannels.map((c) => (
                <li key={c.name}>
                  <span className="v2-ins-bar-label">#{c.name}</span>
                  <span className="v2-ins-bar-track">
                    <span
                      className="v2-ins-bar-fill"
                      style={{ width: `${Math.max(3, (c.messages / topMsgMax) * 100)}%` }}
                    />
                  </span>
                  <span className="v2-ins-bar-val">{c.messages.toLocaleString('en')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="v2-ins-chart">
          <h3>
            Top voice channels <span className="v2-field-hint">({windowLabel})</span>
          </h3>
          {topVoice.length === 0 ? (
            <p className="v2-field-hint">No voice activity recorded yet.</p>
          ) : (
            <ul className="v2-ins-bars">
              {topVoice.map((c) => (
                <li key={c.name}>
                  <span className="v2-ins-bar-label">{c.name}</span>
                  <span className="v2-ins-bar-track">
                    <span
                      className="v2-ins-bar-fill v2-ins-bar-fill-voice"
                      style={{ width: `${Math.max(3, (c.minutes / topVoiceMax) * 100)}%` }}
                    />
                  </span>
                  <span className="v2-ins-bar-val">{fmtDuration(c.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
