import { useState } from 'react';
import { ApiError, disconnectAccount, getAccount } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';

// Which platforms this dashboard account is connected to: "Connect" for the ones that
// are not (a full-page navigation — the platform's login lives on another site), and
// "Disconnect" for the ones that are, except the last one.
export default function Account() {
  const { data, loading, error, setData } = useApiData(() => getAccount(), []);
  const [busy, setBusy] = useState(null);

  if (loading) return <p className="v2-state">Loading your account…</p>;
  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/login">log in again</a>.
          </>
        ) : (
          `Couldn't load your account (${error.message}).`
        )}
      </p>
    );
  }
  if (data.open) {
    return (
      <p className="v2-state">The dashboard is running without login, so there is no account to manage.</p>
    );
  }

  async function disconnect(platform, label) {
    setBusy(platform);
    try {
      await disconnectAccount(platform);
      setData(await getAccount());
      notify(`${label} disconnected`, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Account</h1>
      <p className="v2-muted">
        The platforms you sign in with. Connect a second one to manage your servers on both with the same
        account.
      </p>
      <div className="v2-account-list">
        {data.platforms.map((p) => (
          <section key={p.platform} className="v2-account-card">
            <h3>{p.label}</h3>
            {p.connected ? (
              <>
                <p>
                  Connected as <strong>{p.username}</strong>
                  <span className="v2-muted">
                    {' '}
                    · manages {p.guildCount} server{p.guildCount === 1 ? '' : 's'} with Sylo
                  </span>
                </p>
                {p.canDisconnect ? (
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busy === p.platform}
                    onClick={() => disconnect(p.platform, p.label)}
                  >
                    Disconnect {p.label}
                  </button>
                ) : (
                  <p className="v2-muted">This is your only sign-in, so it can't be disconnected.</p>
                )}
              </>
            ) : (
              <>
                <p className="v2-muted">Not connected.</p>
                {p.connectHref ? (
                  <a className="v2-btn-primary" href={p.connectHref}>
                    Connect {p.label}
                  </a>
                ) : null}
              </>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
