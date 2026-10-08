import { ApiError } from '../api.js';

// The message shown in place of a page whose data failed to load: a signed-out
// session gets a log-in link, anything else gets the error text.
export default function LoadError({ error, what }) {
  const notAuthed = error instanceof ApiError && (error.notAuthenticated || error.status === 401);
  return (
    <p className="v2-state">
      {notAuthed ? (
        <>
          Your session expired — <a href="/auth/discord/login">log in again</a>.
        </>
      ) : (
        `Couldn't load ${what} (${error.message}).`
      )}
    </p>
  );
}
