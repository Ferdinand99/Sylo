import { Link, useParams } from 'react-router-dom';
import { useCmd } from '../platformContext.jsx';
import { getModuleConfig } from '../api.js';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';
import { useApiData } from '../useApiData.js';
import { platformLabel } from '../gamePlatforms.js';

// Read-only — this module has nothing to configure beyond the shared
// enable/disable toggle every module already has (Overview, and the bar at the
// top of the module's own page). No save form.
export default function GameStats() {
  const { guildId } = useParams();
  const cmd = useCmd();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'game-stats'), [guildId]);

  if (error) return <LoadError error={error} what="Game stats" />;
  if (loading && !data) return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">Game stats</h1>
      <p className="v2-field-hint">
        Adds <code>{cmd('/stats')}</code>: pick a game, give a player name, and Sylo posts that player's
        stats. Battlefield numbers come from a public stats service and RuneScape numbers from Jagex's
        official Hiscores.
      </p>

      <h2 className="v2-group-title">Command</h2>
      <ul className="v2-field-hint">
        <li>
          <code>{cmd('/stats game:… username:… [platform:…]')}</code>
        </li>
        <li>Battlefield: BF1, BF3, BF4, BFV, Hardline, plus best-effort BF2042 / BF6 — platform required.</li>
        <li>RuneScape: Old School and RS3 — platform optionally picks an Ironman account type.</li>
        <li>Results are cached for a while to spare the upstream APIs.</li>
      </ul>

      {data.operator ? (
        <>
          <h2 className="v2-group-title">Recently queried stats</h2>
          {data.recent.length === 0 ? (
            <p className="v2-field-hint">Nothing cached yet. Run {cmd('/stats')} to fill it.</p>
          ) : (
            <div className="v2-list">
              {data.recent.map((r, i) => (
                <div className="v2-row" key={i}>
                  <div className="v2-row-main">
                    <h3>{r.title || r.game}</h3>
                    <p>
                      <Meta items={[r.username, platformLabel(r.platform), r.ago]} />
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="v2-field-hint">
            The lookup cache is shared across every server this bot is in.{' '}
            <Link to="/stats">Full cache view →</Link>
          </p>
        </>
      ) : null}
    </>
  );
}
