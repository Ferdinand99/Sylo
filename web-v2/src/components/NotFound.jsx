import { Link } from 'react-router-dom';

// An address that leads nowhere in the dashboard: a mistyped or outdated link, or a settings page
// that does not exist. Drawn inside the Shell (App.jsx's catch-all route), so the sidebar stays; a
// 404 that reaches RouteError uses it too. Not an error: nothing broke, so no "Reload".
export default function NotFound({ title = 'Page not found', guildId = null }) {
  return (
    <div className="v2-state v2-route-error" role="status">
      <p>{title}</p>
      <p className="v2-field-hint">There's nothing at this address. The link may be old or mistyped.</p>
      <p className="v2-route-error-actions">
        {guildId ? (
          <Link className="v2-btn-primary" to={`/guilds/${guildId}`}>
            Back to this server
          </Link>
        ) : null}
        <Link className={guildId ? 'v2-btn-ghost' : 'v2-btn-primary'} to="/">
          Back to your servers
        </Link>
      </p>
    </div>
  );
}
