import { useState } from 'react';
import {
  deleteAccount,
  disconnectAccount,
  getAccount,
  getPrefs,
  revokeDevice,
  setDashboardVersion,
} from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Switch from '../components/Switch.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { plural } from '../components/Meta.jsx';

// Which platforms this dashboard account is connected to: "Connect" for the ones that
// are not (a full-page navigation — the platform's login lives on another site), and
// "Disconnect" for the ones that are, except the last one. Below, the Sylo app devices
// signed in to the account, each with "Revoke".

function lastUsed(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
export default function Account() {
  const { data, loading, error, setData } = useApiData(() => getAccount(), []);
  const [busy, setBusy] = useState(null);
  const prefs = useApiData(() => getPrefs(), []);

  if (error) return <LoadError error={error} what="your account" />;
  if (loading || !data) return <p className="v2-state">Loading your account…</p>;
  if (data.open) {
    return (
      <p className="v2-state">The dashboard is running without login, so there is no account to manage.</p>
    );
  }

  // Optimistic: flip the switch at once, put it back if the save fails.
  async function setV2Default(on) {
    const previous = prefs.data;
    prefs.setData({ dashboardVersion: on ? 'v2' : 'v1' });
    setBusy('prefs');
    try {
      prefs.setData(await setDashboardVersion(on ? 'v2' : 'v1'));
    } catch (err) {
      prefs.setData(previous);
      notify(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(device) {
    setBusy(device.id);
    try {
      await revokeDevice(device.id);
      setData(await getAccount());
      notify(`${device.deviceName || 'Device'} signed out`, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function removeAccount() {
    const ok = await confirmDialog({
      title: 'Delete your Sylo account?',
      body: "Your sign-ins, every signed-in browser and app device, and your dashboard preferences are deleted. This can't be undone.",
      confirmLabel: 'Delete account',
      typeToConfirm: 'DELETE',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await deleteAccount();
      window.location.assign('/');
    } catch (err) {
      notify(err.message);
      setBusy(null);
    }
  }

  async function disconnect(platform, label) {
    const ok = await confirmDialog({
      title: `Disconnect ${label}?`,
      body: `You can no longer sign in with ${label} until you connect it again.`,
      confirmLabel: `Disconnect ${label}`,
    });
    if (!ok) return;
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
                <p className="v2-break">
                  Connected as <strong>{p.username || 'unknown user'}</strong>
                  <span className="v2-muted"> · manages {plural(p.guildCount ?? 0, 'server')} with Sylo</span>
                </p>
                {p.canDisconnect ? (
                  <button
                    type="button"
                    className="v2-btn-danger"
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
              <h3 className="v2-break">{d.deviceName || 'Unnamed device'}</h3>
              <p className="v2-muted">Last used {lastUsed(d.lastUsedAt)}</p>
              <button
                type="button"
                className="v2-btn-danger"
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

      <h2 className="v2-section-title">Dashboard</h2>
      <div className="v2-group">
        <div className="v2-list">
          <div className="v2-row">
            <div className="v2-row-main">
              <h3>Open the new dashboard by default</h3>
              <p>
                When on, signing in opens this dashboard. &lsquo;Back to classic dashboard&rsquo; still works
                for the rest of your visit.
              </p>
            </div>
            <Switch
              checked={prefs.data?.dashboardVersion === 'v2'}
              onChange={setV2Default}
              label="Open the new dashboard by default"
              disabled={!prefs.data || busy === 'prefs'}
            />
          </div>
        </div>
      </div>

      <h2 className="v2-section-title">Delete account</h2>
      <p className="v2-muted">
        Deletes your Sylo dashboard account: your sign-ins, every browser and Sylo app device signed in with
        it, and your dashboard preferences. Data Sylo keeps per server (levels, birthdays, tickets …) stays
        with each server; run <code>/forget</code> there to remove it.
      </p>
      <button type="button" className="v2-btn-danger" disabled={busy === 'delete'} onClick={removeAccount}>
        Delete account
      </button>
    </>
  );
}
