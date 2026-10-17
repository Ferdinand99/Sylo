import { useState } from 'react';
import { ApiError, disconnectAccount, getAccount, revokeDevice } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';

// Which platforms this dashboard account is connected to: "Connect" for the ones that
// are not (a full-page navigation — the platform's login lives on another site), and
// "Disconnect" for the ones that are, except the last one. Below, the Sylo app devices
// signed in to the account, each with "Revoke".

function lastUsed(ms) {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
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

  async function revoke(device) {
    setBusy(device.id);
    try {
      await revokeDevice(device.id);
      setData(await getAccount());
      notify(`${device.deviceName} signed out`, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(null);
    }
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

      <h2 className="v2-section-title">Signed-in devices</h2>
      <p className="v2-muted">
        Devices signed in to the Sylo app with this account. Revoke one you no longer use or don't recognise;
        it is signed out at once.
      </p>
      {data.devices.length ? (
        <div className="v2-account-list">
          {data.devices.map((d) => (
            <section key={d.id} className="v2-account-card">
              <h3>{d.deviceName}</h3>
              <p className="v2-muted">Last used {lastUsed(d.lastUsedAt)}</p>
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={busy === d.id}
                onClick={() => revoke(d)}
              >
                Revoke
              </button>
            </section>
          ))}
        </div>
      ) : (
        <p className="v2-muted">No devices are signed in.</p>
      )}
    </>
  );
}
