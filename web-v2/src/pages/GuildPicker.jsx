import { Link, useOutletContext } from 'react-router-dom';
import PlatformBadge from '../components/PlatformBadge.jsx';
import LoadError from '../components/LoadError.jsx';
import { initial } from '../util.js';

export default function GuildPicker() {
  const { guilds, guildsLoading, guildsError } = useOutletContext();

  if (guildsError) return <LoadError error={guildsError} what="your servers" />;
  if (guildsLoading || !guilds) return <p className="v2-state">Loading your servers…</p>;

  const multiPlatform = new Set(guilds.map((g) => g.platform)).size > 1;

  if (!guilds.length) {
    return (
      <p className="v2-state">
        No servers found. Invite Sylo to a server where you have <strong>Manage Server</strong>, then reload.
      </p>
    );
  }

  return (
    <>
      <h1 className="v2-section-title">Choose a server</h1>
      <div className="v2-card-grid">
        {guilds.map((g) => (
          <Link key={g.id} to={`/guilds/${g.id}`} className="v2-card v2-guild-card">
            <h3 className="v2-break">
              {g.name}
              {multiPlatform ? <PlatformBadge platform={g.platform} /> : null}
            </h3>
            {g.icon ? (
              <img src={g.icon} alt="" width={32} height={32} className="v2-guild-card-icon" />
            ) : (
              <span className="v2-guild-card-icon v2-guild-card-ph" aria-hidden="true">
                {initial(g.name)}
              </span>
            )}
          </Link>
        ))}
      </div>
    </>
  );
}
