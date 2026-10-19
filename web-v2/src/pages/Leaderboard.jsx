import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getLeaderboard, setLeaderboardPublic, setLeaderboardVanity } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Switch from '../components/Switch.jsx';
import Meta, { plural } from '../components/Meta.jsx';
import { formatCount } from '../util.js';
import Reveal from '../components/Reveal.jsx';

const PERIODS = [
  { key: 'all', label: 'All time' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

export default function Leaderboard() {
  const { guildId } = useParams();
  const [period, setPeriod] = useState('all');
  const { data, error, setData } = useApiData(() => getLeaderboard(guildId, period), [guildId, period]);
  const [slugInput, setSlugInput] = useState('');
  const [saving, setSaving] = useState(false);

  // Keep the vanity-slug input in sync whenever fresh data lands (a new
  // guild/period, or after saving) — but not on every keystroke, since this
  // effect only re-runs when `data` itself changes.
  useEffect(() => {
    if (data) setSlugInput(data.vanitySlug || '');
  }, [data]);

  if (error) return <LoadError error={error} what="the leaderboard" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  async function togglePublic() {
    if (saving) return;
    setSaving(true);
    try {
      const { publicLeaderboard } = await setLeaderboardPublic(guildId, !data.publicLeaderboard);
      setData((d) => ({ ...d, publicLeaderboard }));
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveVanity(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { vanitySlug } = await setLeaderboardVanity(guildId, slugInput);
      setData((d) => ({ ...d, vanitySlug }));
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Reveal>
      <h1 className="v2-section-title">Leaderboard</h1>

      {!data.levelingEnabled ? (
        <p className="v2-note">
          The Leveling module is off — turn it on from the Overview page to start ranking members.
        </p>
      ) : null}

      <div className="v2-group">
        <div className="v2-list">
          <div className="v2-row">
            <div className="v2-row-main">
              <h3>Public leaderboard</h3>
              <p>Anyone with the link can view it, without signing in.</p>
            </div>
            <Switch
              checked={data.publicLeaderboard}
              onChange={togglePublic}
              label="Public leaderboard"
              disabled={saving}
            />
          </div>
          {data.publicLeaderboard ? (
            <form className="v2-row v2-row-stack" onSubmit={saveVanity}>
              <div className="v2-row-main">
                <h3>Vanity URL</h3>
                <p className="v2-break is-wrap">sylobot.com/lb/{slugInput || '…'}</p>
              </div>
              <div className="v2-row-actions v2-vanity-actions">
                <input
                  className="v2-inline-input"
                  aria-label="Vanity URL slug"
                  value={slugInput}
                  onChange={(e) => setSlugInput(e.target.value)}
                  placeholder="my-server"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="done"
                />
                <button type="submit" className="v2-btn-ghost" disabled={saving}>
                  Save
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </div>

      <div className="v2-tabs">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`v2-tab${period === p.key ? ' is-active' : ''}`}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="v2-list">
        {data.rows.length ? (
          data.rows.map((r) => (
            <div className="v2-row" key={r.rank}>
              <div className="v2-row-main">
                <h3 className="v2-break">
                  <span className="v2-id">#{formatCount(r.rank)}</span>
                  {r.name}
                </h3>
                <p>
                  <Meta
                    items={[
                      r.level !== null && r.level !== undefined && `Level ${formatCount(r.level)}`,
                      `${formatCount(r.xp)} XP`,
                      plural(r.messages, 'message'),
                    ]}
                  />
                </p>
              </div>
            </div>
          ))
        ) : (
          <div className="v2-row">
            <div className="v2-row-main">
              <p>No ranked members yet for this period.</p>
            </div>
          </div>
        )}
      </div>
    </Reveal>
  );
}
