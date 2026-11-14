import { Link, useOutletContext } from 'react-router-dom';
import PlatformBadge from '../components/PlatformBadge.jsx';
import FreeLine from '../components/FreeLine.jsx';
import LoadError from '../components/LoadError.jsx';
import { getInvites } from '../api.js';
import { useApiData } from '../useApiData.js';
import { initial } from '../util.js';

export default function GuildPicker() {
  const { guilds, guildsLoading, guildsError } = useOutletContext();
  // Where Sylo can be added to another server (one link per platform that is set up).
  const { data: invites } = useApiData(
    () =>
      Promise.resolve()
        .then(getInvites)
        .catch(() => []),
    []
  );
  const addLinks = invites ?? [];

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
        {addLinks.map((inv) => (
          <a
            key={inv.platform}
            href={inv.url}
            target="_blank"
            rel="noopener noreferrer"
            className="v2-card v2-guild-card v2-guild-add"
          >
            <h3 className="v2-break">
              {addLinks.length > 1 ? `Add Sylo to a server on ${inv.label}` : 'Add Sylo to another server'}
            </h3>
            <span className="v2-guild-card-icon v2-guild-card-ph" aria-hidden="true">
              ＋
            </span>
          </a>
        ))}
      </div>
      <FreeLine />
    </>
  );
}
