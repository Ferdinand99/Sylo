import { Link, useRouteError } from 'react-router-dom';

// Shown in place of a page that threw while rendering. A page loads as its own
// file on first visit, so after a deploy an open tab can ask for a file that no
// longer exists — that case gets a reload button instead of an error text.
const STALE_CHUNK =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

export default function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error?.statusText ?? error ?? '');
  const stale = STALE_CHUNK.test(message);

  return (
    <div className="v2-state v2-route-error" role="alert">
      <p>
        {stale
          ? 'Sylo has been updated since this page was opened. Reload to get the new version.'
          : 'Something went wrong on this page.'}
      </p>
      {!stale && message ? <p className="v2-field-hint v2-break">{message}</p> : null}
      <p className="v2-route-error-actions">
        <button type="button" className="v2-btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link className="v2-btn-ghost" to="/">
          Back to your servers
        </Link>
      </p>
    </div>
  );
}
