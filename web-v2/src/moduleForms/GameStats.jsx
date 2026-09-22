import { useParams } from 'react-router-dom';
import { getModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

// Read-only — this module has nothing to configure beyond the shared
// enable/disable toggle every module already has from Overview. Matches
// V1's game-stats.ejs, which has no save form either.
export default function GameStats() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'game-stats'), [guildId]);

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
          `Couldn't load Game stats (${error.message}).`
        )}
      </p>
    );
  }

  return (
    <>
      <h1 className="v2-section-title">Game stats</h1>
      <p className="v2-field-hint">
        Adds <code>/stats</code> — pick a game from the dropdown, give a player name, and Sylo returns an
        embed of their stats. Battlefield data comes from the public gametools.network API; RuneScape data
        from Jagex's official Hiscores. Enable this module here to make the command available in this server.
      </p>

      <h2 className="v2-group-title">Command</h2>
      <ul className="v2-field-hint">
        <li>
          <code>/stats game:… username:… [platform:…]</code>
        </li>
        <li>Battlefield: BF1, BF3, BF4, BFV, Hardline, plus best-effort BF2042 / BF6 — platform required.</li>
        <li>RuneScape: Old School and RS3 — platform optionally picks an Ironman account type.</li>
        <li>Results are cached for a while to spare the upstream APIs.</li>
      </ul>

      <h2 className="v2-group-title">Recently queried stats</h2>
      {data.recent.length === 0 ? (
        <p className="v2-field-hint">Nothing cached yet — run /stats in Discord.</p>
      ) : (
        <div className="v2-list">
          {data.recent.map((r, i) => (
            <div className="v2-row" key={i}>
              <div className="v2-row-main">
                <h3>
                  {r.game} — {r.title}
                </h3>
                <p>
                  {r.username} · {r.platform} · {r.ago}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="v2-field-hint">The lookup cache is shared across every server this bot is in.</p>
    </>
  );
}
