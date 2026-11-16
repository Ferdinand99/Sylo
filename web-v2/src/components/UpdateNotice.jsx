import { useCallback, useEffect, useRef, useState } from 'react';
import { parseInline } from '../../../src/lib/changelog.js';
import { approveUpdate, ApiError, getUpdateRun } from '../api.js';
import { describeRun, loadUpdateStatus, readStoredRun, syloIsDown, writeStoredRun } from '../updateModel.js';
import Callout from './Callout.jsx';
import CopyButton from './CopyButton.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';

const POLL_MS = 3000;
// Stop asking after this long: an update that has not come back by then needs a person.
const GIVE_UP_MS = 30 * 60 * 1000;
const WREN_URL = 'https://github.com/Ferdinand99/Wise-Wren';

// The notes come from the server already cut down to https links, and are shown as text: a link is only
// made for an https address, and nothing here is ever HTML.
function Segments({ text }) {
  return parseInline(text).map((s, i) => {
    if (s.code) return <code key={i}>{s.code}</code>;
    if (s.href && /^https:\/\//i.test(s.href))
      return (
        <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
          {s.text}
        </a>
      );
    if (s.bold) return <strong key={i}>{s.text}</strong>;
    return <span key={i}>{s.text}</span>;
  });
}

function ReleaseNotes({ notes, notesText }) {
  if (!notes && !notesText) return null;
  return (
    <details className="v2-upd-notes">
      <summary>What&apos;s in this release</summary>
      {notes ? (
        notes.sections.map((section) => (
          <section className="v2-cl-section" key={section.title}>
            <h3 className={section.kind === 'breaking' ? 'is-breaking' : undefined}>{section.title}</h3>
            <ul>
              {section.items.map((item, i) => (
                <li key={i}>
                  {item.scope ? <span className="v2-cl-scope">{item.scope}</span> : null}
                  <span className="v2-cl-text">
                    <Segments text={item.text} />
                  </span>
                  {item.refs
                    .filter((ref) => /^https:\/\//i.test(ref.url))
                    .map((ref) => (
                      <a
                        key={ref.label}
                        className="v2-cl-ref"
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {ref.label}
                      </a>
                    ))}
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="v2-upd-notes-text">{notesText}</p>
      )}
    </details>
  );
}

/**
 * Follows the Wise Wren run Sylo asked for. Sylo restarts in the middle of it: the polls then fail, and the
 * view keeps asking until Sylo answers again. It is done when Wise Wren says so, or when Sylo comes back
 * reporting another version than the one the update started from.
 */
function UpdateProgress({ id, from, onClose }) {
  const [view, setView] = useState({
    run: null,
    down: false,
    wrenError: null,
    version: null,
  });
  const started = useRef(Date.now());

  useEffect(() => {
    let live = true;
    let timer;
    let wasDown = false;

    async function tick() {
      let next = {};
      let finished = false;
      try {
        const res = await getUpdateRun(id);
        next = { run: res.run, down: false, wrenError: null };
        finished = Boolean(res.run?.finished);
      } catch (err) {
        if (syloIsDown(err)) {
          wasDown = true;
          next = { down: true };
        } else if (err instanceof ApiError && String(err.code ?? '').startsWith('wren_')) {
          next = { down: false, wrenError: err.message };
        } else {
          next = { down: false, wrenError: 'Could not read the update progress.' };
        }
      }
      // Back after a restart, or finished, or no run to read: Sylo's own version tells whether it worked.
      if (!next.down && (wasDown || finished)) {
        try {
          const status = await loadUpdateStatus({ fresh: true });
          if (status?.current && status.current !== from) next.version = status.current;
        } catch {
          // not reachable yet; the next tick tries again
        }
      }
      if (!live) return;
      setView((v) => ({ ...v, ...next, version: next.version ?? v.version }));
      if (next.version || finished) {
        writeStoredRun(null);
        return;
      }
      if (Date.now() - started.current > GIVE_UP_MS) return;
      timer = setTimeout(tick, POLL_MS);
    }

    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, from]);

  const said = describeRun(view.run);
  const timedOut = !view.version && Date.now() - started.current > GIVE_UP_MS;
  let body;
  if (view.version) {
    body = (
      <>
        <strong>Sylo is now on {view.version}.</strong> Reload the page to load the new dashboard.
      </>
    );
  } else if (view.down) {
    body = <>Sylo is restarting. This page keeps trying and shows the result as soon as Sylo is back.</>;
  } else {
    body = (
      <>
        {said.text}
        {said.step ? <span className="v2-upd-step"> Now: {said.step}.</span> : null}
      </>
    );
  }
  const tone = view.version ? 'success' : view.down ? 'working' : said.tone;

  return (
    <div className={`v2-upd-progress is-${tone}`} role="status" aria-live="polite">
      <p>{body}</p>
      {view.wrenError ? <p className="v2-row-warn">{view.wrenError}</p> : null}
      {timedOut ? (
        <p className="v2-row-warn">
          Sylo has not come back after 30 minutes. Look at the run in Wise Wren and at Sylo&apos;s container.
        </p>
      ) : null}
      <div className="v2-row-actions">
        {view.version ? (
          <button type="button" className="v2-btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        ) : null}
        {view.version || view.run?.finished || timedOut ? (
          <button type="button" className="v2-btn-ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The "Updates" section of the Health page (operators only): whether a newer Sylo is out, its release notes,
 * the command to update by hand and, when Wise Wren is set up, "Update now" with the run's progress.
 */
export default function UpdateNotice() {
  const [state, setState] = useState({ loading: true, data: null, failed: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [run, setRun] = useState(() => readStoredRun());

  const load = useCallback(async ({ refresh = false } = {}) => {
    try {
      const data = await loadUpdateStatus({ fresh: true, refresh });
      setState({ loading: false, data, failed: false });
      // An update that is already running (started here earlier, or in Wise Wren) is followed too.
      const latest = data?.wren?.latestRun;
      if (latest && !latest.finished) {
        setRun((current) => current ?? { id: latest.id, from: data.current });
      }
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403)
        setState({ loading: false, data: null, failed: false });
      else setState({ loading: false, data: null, failed: true });
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (state.loading) return null;
  if (state.failed) {
    return (
      <div className="v2-group" id="update">
        <h2 className="v2-group-title">Updates</h2>
        <p className="v2-field-hint">Could not read the update status. Try again in a moment.</p>
      </div>
    );
  }
  const d = state.data;
  if (!d) return null;
  const wren = d.wren;

  async function recheck() {
    setBusy(true);
    setMessage('');
    try {
      await load({ refresh: true });
    } finally {
      setBusy(false);
    }
  }

  async function updateNow() {
    const ok = await confirmDialog({
      title: `Update Sylo to ${d.latest ?? 'the new version'}?`,
      body: (
        <>
          Wise Wren stops Sylo for a short while, takes a snapshot, starts the new version and rolls back if
          it does not come up healthy. The dashboard and the bot are offline meanwhile.
        </>
      ),
      confirmLabel: 'Update now',
      tone: 'default',
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      const started = await approveUpdate();
      const next = { id: started.runId, from: started.from };
      writeStoredRun(next);
      setRun(next);
    } catch (err) {
      setMessage(err.message || 'Could not start the update.');
    } finally {
      setBusy(false);
    }
  }

  function closeRun() {
    writeStoredRun(null);
    setRun(null);
    load();
  }

  let headline;
  if (!d.enabled) headline = `Sylo ${d.current}. The update check is off (UPDATE_CHECK=off).`;
  else if (d.available) headline = `Sylo ${d.latest} is available. This Sylo runs ${d.current}.`;
  else if (d.checkFailed && !d.latest)
    headline = `Sylo ${d.current}. The latest release could not be checked.`;
  else headline = `Sylo ${d.current} is up to date.`;

  return (
    <div className="v2-group" id="update">
      <h2 className="v2-group-title">Updates</h2>
      <div className="v2-list">
        <div className="v2-row v2-row-stack">
          <div className="v2-row-main">
            <p className="is-wrap">
              <strong>{headline}</strong>
              {d.available && d.releaseUrl ? (
                <>
                  {' '}
                  <a href={d.releaseUrl} target="_blank" rel="noopener noreferrer">
                    Release on GitHub
                  </a>
                </>
              ) : null}
            </p>
            {d.available ? <ReleaseNotes notes={d.notes} notesText={d.notesText} /> : null}
            {d.available ? (
              <div className="v2-upd-command">
                <p className="v2-field-hint">
                  To update by hand, run this where Sylo&apos;s compose file is:
                </p>
                <div className="v2-upd-command-row">
                  <code>{d.command}</code>
                  <CopyButton text={d.command} what="update command" />
                </div>
              </div>
            ) : null}
            {d.enabled && d.checkFailed && d.latest ? (
              <p className="v2-field-hint">The last check failed; this is from an earlier one.</p>
            ) : null}
          </div>
          {d.enabled ? (
            <div className="v2-row-actions">
              <button type="button" className="v2-btn-ghost" onClick={recheck} disabled={busy}>
                Check again
              </button>
            </div>
          ) : null}
        </div>

        {wren ? (
          <div className="v2-row v2-row-stack">
            <div className="v2-row-main">
              <h3>Wise Wren</h3>
              {run ? (
                <UpdateProgress id={run.id} from={run.from} onClose={closeRun} />
              ) : wren.error ? (
                <p className="v2-row-warn">{wren.error.message}</p>
              ) : (
                <>
                  <p className="is-wrap">
                    {wren.target
                      ? wren.updateSeen
                        ? `Wise Wren sees an update for ${wren.target.name}.`
                        : `Wise Wren does not see an update for ${wren.target.name} yet.`
                      : 'Wise Wren is connected. Its token cannot read the target, so the check above decides.'}
                  </p>
                  {wren.whyNot && (d.available || wren.updateSeen) ? (
                    <p className="v2-field-hint">{wren.whyNot}</p>
                  ) : null}
                </>
              )}
              {message ? <p className="v2-row-warn">{message}</p> : null}
            </div>
            {!run && !wren.error && (d.available || wren.updateSeen) ? (
              <div className="v2-row-actions">
                <button
                  type="button"
                  className="v2-btn-primary"
                  onClick={updateNow}
                  disabled={busy || !wren.canApprove}
                >
                  Update now
                </button>
              </div>
            ) : null}
          </div>
        ) : d.available ? (
          <div className="v2-row v2-row-stack">
            <div className="v2-row-main">
              <Callout tone="info" title="Update from here">
                <p>
                  <a href={WREN_URL} target="_blank" rel="noopener noreferrer">
                    Wise Wren
                  </a>{' '}
                  can update Sylo from this page, without a command line. Set WISE_WREN_URL, WISE_WREN_TOKEN
                  and WISE_WREN_TARGET_ID (see the self-hosting guide, &quot;Updating Sylo&quot;).
                </p>
              </Callout>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
