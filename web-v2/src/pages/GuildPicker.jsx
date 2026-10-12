import { Link, useOutletContext } from 'react-router-dom';
import { ApiError } from '../api.js';
import PlatformBadge from '../components/PlatformBadge.jsx';

export default function GuildPicker() {
  const { guilds, guildsLoading, guildsError } = useOutletContext();

  if (guildsLoading) return <p className="v2-state">Loading your servers…</p>;

  if (guildsError) {
    const notAuthed = guildsError instanceof ApiError && guildsError.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/login">log in again</a>.
          </>
        ) : (
          `Couldn't load your servers (${guildsError.message}).`
        )}
      </p>
    );
  }

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
          <Link key={g.id} to={`/guilds/${g.id}`} className="v2-card">
            <h3>
              {g.name}
              {multiPlatform ? <PlatformBadge platform={g.platform} /> : null}
            </h3>
            {g.icon ? <img src={g.icon} alt="" width={32} height={32} style={{ borderRadius: 8 }} /> : null}
          </Link>
        ))}
      </div>
    </>
  );
}
