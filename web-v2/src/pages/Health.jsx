import { useEffect, useRef, useState } from 'react';
import {
  getHealth,
  sendDevLogTest,
  sendDevLogErrorTest,
  createBackup,
  deleteBackup,
  restoreBackup,
  importBackup,
  ApiError,
} from '../api.js';

function Sparkline({ history }) {
  if (!history || history.length < 2) return null;
  const w = 240;
  const h = 32;
  const lo = Math.min(...history);
  const hi = Math.max(...history);
  const span = Math.max(1, hi - lo);
  const points = history
    .map((v, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - 2 - ((v - lo) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <>
      <svg
        className="v2-sparkline"
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Gateway ping, last ${history.length} samples, ${lo} to ${hi} ms`}
      >
        <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} />
      </svg>
      <p className="v2-field-hint">
        {lo}–{hi} ms over the last {history.length} min
      </p>
    </>
  );
}

export default function Health() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const fileInputRef = useRef(null);

  function load() {
    return getHealth()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, []);

  // After a restore is triggered, the process exits and restarts — poll
  // /api/v2/health until it answers again, then reload. Mirrors V1's
  // restoring.ejs, which does the same thing against GET /health.
  useEffect(() => {
    if (!restoring) return undefined;
    const id = setInterval(() => {
      getHealth()
        .then(() => {
          clearInterval(id);
          setRestoring(null);
          load();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [restoring]);

  if (state.loading) return <p className="v2-state">Loading…</p>;

  if (restoring) {
    return (
      <p className="v2-state">
        Restoring from <strong>{restoring}</strong>… the bot is restarting, this page will refresh itself.
      </p>
    );
  }

  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    const forbidden = state.error instanceof ApiError && state.error.status === 403;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : forbidden ? (
          "This page is restricted to Sylo's operators."
        ) : (
          `Couldn't load health status (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function run(action, successMsg) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice(successMsg(result));
      await load();
      return result;
    } catch (err) {
      setNotice(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onCreateBackup() {
    await run(createBackup, (r) => `Backup created: ${r.name}`);
  }

  async function onDeleteBackup(name) {
    if (!confirm('Delete this backup permanently?')) return;
    await run(
      () => deleteBackup(name),
      () => `Deleted ${name}.`
    );
  }

  async function onRestoreBackup(name) {
    if (!confirm(`Restore the database from "${name}"? This replaces all current data and restarts the bot.`))
      return;
    const result = await run(
      () => restoreBackup(name),
      () => 'Restoring…'
    );
    if (result?.ok) setRestoring(name);
  }

  async function onImportFile(e) {
    const file = fileInputRef.current?.files?.[0];
    e.preventDefault();
    if (!file) return;
    if (!confirm(`Upload "${file.name}" as a backup snapshot?`)) return;
    const result = await run(
      () => importBackup(file),
      (r) => `Imported ${r.name} — use Restore on that row to load it.`
    );
    if (result && fileInputRef.current) fileInputRef.current.value = '';
  }

  async function onDevLogTest() {
    await run(sendDevLogTest, (r) =>
      r.ok ? 'Test message sent — check the channel.' : `Test failed: ${r.error}`
    );
  }

  async function onDevLogErrorTest() {
    await run(
      sendDevLogErrorTest,
      () =>
        "Test log.error() triggered — check the channel in a moment. Won't repost if an identical test posted in the last 5 minutes."
    );
  }

  return (
    <>
      <h1 className="v2-section-title">Health &amp; status</h1>

      {notice ? <p className="v2-note">{notice}</p> : null}

      <div className="v2-stat-strip">
        <div className="v2-stat">
          <strong>{d.ready ? 'Online' : 'Offline'}</strong>
          <span>
            {d.botTag ?? 'not connected'} · v{d.version}
          </span>
        </div>
        <div className="v2-stat">
          <strong>{d.guildCount}</strong>
          <span>{d.memberReach.toLocaleString()} members reached</span>
        </div>
        <div className="v2-stat">
          <strong>{d.uptime}</strong>
          <span>gateway ping {d.gatewayPing === null ? '—' : `${d.gatewayPing} ms`}</span>
          <Sparkline history={d.pingHistory} />
        </div>
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Dev-log channel</h2>
        <div className="v2-list">
          <div className="v2-row">
            <div className="v2-row-main">
              <p>
                {d.devLogConfigured
                  ? 'Sylo posts its own errors here — separate from any per-guild logging/modlog channel.'
                  : 'Not set up — set DEV_LOG_CHANNEL_ID to a channel id to get a proactive Discord message whenever Sylo logs an error.'}
              </p>
            </div>
            {d.devLogConfigured ? (
              <div className="v2-field-row">
                <button type="button" className="v2-btn-ghost" onClick={onDevLogTest} disabled={busy}>
                  Send test message
                </button>
                <button type="button" className="v2-btn-ghost" onClick={onDevLogErrorTest} disabled={busy}>
                  Trigger a real log.error()
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {d.errors.length ? (
        <div className="v2-group">
          <h2 className="v2-group-title">Recent errors ({d.errors.length} shown, newest first)</h2>
          <div className="v2-list">
            {d.errors.map((e, i) => (
              <div className="v2-row" key={i}>
                <div className="v2-row-main">
                  <h3>{e.scope || '—'}</h3>
                  <p>{e.message}</p>
                </div>
                <span className="v2-field-hint">{e.ago}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="v2-stat-strip v2-section-gap">
        <div className="v2-stat">
          <strong>{d.stats.openTickets}</strong>
          <span>{d.stats.ticketsTotal} tickets all-time</span>
        </div>
        <div className="v2-stat">
          <strong>{d.stats.warningsTotal}</strong>
          <span>{d.stats.warningsWeek} warnings in 7 days</span>
        </div>
        <div className="v2-stat">
          <strong>{d.stats.composedTotal}</strong>
          <span>composed messages</span>
        </div>
        <div className="v2-stat">
          <strong>{d.stats.cachedLookups}</strong>
          <span>cached stat lookups</span>
        </div>
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Module adoption</h2>
        {d.modules.length === 0 ? (
          <p className="v2-note">No modules enabled yet — pick a server and turn some on.</p>
        ) : (
          <div className="v2-list">
            {d.modules.map((m) => (
              <div className="v2-row" key={m.name}>
                <div className="v2-row-main">
                  <h3>
                    {m.icon} {m.name}
                  </h3>
                </div>
                <span>{m.guilds}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Database &amp; backups</h2>
        <p className="v2-note">
          Database <strong>{d.db.size}</strong>
          {d.db.wal !== null ? ` (WAL ${d.db.wal})` : ''}.{' '}
          {d.db.intervalHours > 0
            ? `Automatic snapshot every ${d.db.intervalHours}h, keeping the newest ${d.db.retention}.`
            : d.db.postgres
              ? 'Scheduled backups are off.'
              : 'Scheduled backups are off — a snapshot is still taken before every schema migration.'}{' '}
          Snapshots are written to <code>&lt;data&gt;/backups</code> on the mounted volume.
          {d.db.offsite ? ` A gzipped copy of each is also shipped off-site (${d.db.offsite}).` : ''}
        </p>
        <div className="v2-field-row v2-section-gap">
          <button type="button" className="v2-btn-primary" onClick={onCreateBackup} disabled={busy}>
            Create backup now
          </button>
          <form onSubmit={onImportFile} className="v2-field-row">
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3,.dump,application/octet-stream"
              className="v2-field-hint"
            />
            <button type="submit" className="v2-btn-ghost" disabled={busy}>
              Import backup file…
            </button>
          </form>
        </div>
        <p className="v2-field-hint">
          Importing stores the file as a snapshot; you then Restore it. Restoring replaces the live database
          and restarts the bot (a <code>prerestore</code> snapshot is taken first).
        </p>

        {d.backups.length === 0 ? (
          <p className="v2-note">No snapshots yet.</p>
        ) : (
          <div className="v2-list v2-section-gap">
            {d.backups.map((b) => (
              <div className="v2-row" key={b.name}>
                <div className="v2-row-main">
                  <h3>
                    <a href={`/health/backups/${encodeURIComponent(b.name)}`}>{b.name}</a>
                  </h3>
                  <p>
                    {b.size} · {b.ago}
                  </p>
                </div>
                <div className="v2-field-row">
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    onClick={() => onRestoreBackup(b.name)}
                    disabled={busy}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    onClick={() => onDeleteBackup(b.name)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
