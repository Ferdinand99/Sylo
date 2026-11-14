import { Link } from 'react-router-dom';
import { ApiError } from '../api.js';

/** The refusal for a server the signed-in account does not manage (the server says "You do not manage this server."). */
export const isNoAccess = (error) =>
  error instanceof ApiError && error.status === 403 && /manage this server/i.test(error.message ?? '');

// The message shown in place of a page whose data failed to load: a signed-out
// session gets a log-in link, a server the person does not manage gets a friendly
// page that leads back to their own servers, anything else gets the error text.
export default function LoadError({ error, what }) {
  const notAuthed = error instanceof ApiError && (error.notAuthenticated || error.status === 401);
  if (isNoAccess(error)) {
    return (
      <div className="v2-state v2-route-error v2-no-access" role="status">
        <p>You don't have access to this server</p>
        <p className="v2-field-hint">
          Only people who manage a server, or hold one of its bot-master roles, can open its dashboard.
        </p>
        <p className="v2-route-error-actions">
          <Link className="v2-btn-primary" to="/">
            Choose another server
          </Link>
        </p>
      </div>
    );
  }
  return (
    <p className="v2-state">
      {notAuthed ? (
        <>
          Your session expired — <a href="/auth/login">sign in again</a>.
        </>
      ) : (
        `Couldn't load ${what} (${error.message}).`
      )}
    </p>
  );
}
