import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getLeaderboard, setLeaderboardPublic, setLeaderboardVanity, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

const PERIODS = [
  { key: 'all', label: 'All time' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

export default function Leaderboard() {
  const { guildId } = useParams();
  const [period, setPeriod] = useState('all');
  const { data, loading, error, setData } = useApiData(
    () => getLeaderboard(guildId, period),
    [guildId, period]
  );
  const [slugInput, setSlugInput] = useState('');
  const [saving, setSaving] = useState(false);

  // Keep the vanity-slug input in sync whenever fresh data lands (a new
  // guild/period, or after saving) — but not on every keystroke, since this
  // effect only re-runs when `data` itself changes.
  useEffect(() => {
    if (data) setSlugInput(data.vanitySlug || '');
  }, [data]);

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
          `Couldn't load the leaderboard (${error.message}).`
        )}
      </p>
    );
  }

  async function togglePublic() {
    if (saving) return;
    setSaving(true);
    try {
      const { publicLeaderboard } = await setLeaderboardPublic(guildId, !data.publicLeaderboard);
      setData((d) => ({ ...d, publicLeaderboard }));
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
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
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
            <button
              type="button"
              className={`v2-toggle${data.publicLeaderboard ? ' is-on' : ''}`}
              aria-label={
                data.publicLeaderboard ? 'Public — click to make private' : 'Private — click to make public'
              }
              onClick={togglePublic}
              disabled={saving}
            />
          </div>
          {data.publicLeaderboard ? (
            <form className="v2-row" onSubmit={saveVanity}>
              <div className="v2-row-main">
                <h3>Vanity URL</h3>
                <p>sylobot.com/lb/{slugInput || '…'}</p>
              </div>
              <input
                className="v2-inline-input"
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                placeholder="my-server"
              />
              <button type="submit" className="v2-btn-ghost" disabled={saving}>
                Save
              </button>
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
                <h3>
                  #{r.rank} {r.name}
                </h3>
                <p>
                  {r.level !== null ? `Level ${r.level} · ` : ''}
                  {r.xp.toLocaleString()} XP · {r.messages.toLocaleString()} messages
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
    </>
  );
}
