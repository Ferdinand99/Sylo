import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  acceptMirror,
  getMirror,
  getMirrorPreview,
  getMirrorReport,
  mirrorAction,
  requestMirror,
  setMirrorOptions,
  startMirror,
} from '../api.js';
import { useApiData } from '../useApiData.js';
import { AccessLock, useAccess } from '../access.jsx';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Reveal from '../components/Reveal.jsx';
import Callout from '../components/Callout.jsx';
import Field from '../components/Field.jsx';
import Switch from '../components/Switch.jsx';
import Time from '../components/Time.jsx';
import CopyButton from '../components/CopyButton.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import {
  OPTION_ROWS,
  STEPS,
  codeLeft,
  groupNotes,
  isBusy,
  progressText,
  statusOf,
  stepOf,
  summaryLines,
  validTargetId,
} from '../mirrorModel.js';

const POLL_MS = 3000;

// Copy a Discord server's structure to a Fluxer server, and keep it in step (src/mirror/). The same page serves
// both servers of a pair: the Discord server asks, previews and copies; the Fluxer server agrees with the code and
// may pause or stop the mirror.
export default function Mirror() {
  const { guildId } = useParams();
  const { data, error, setData } = useApiData(() => getMirror(guildId), [guildId], guildId);
  // The one-time code is shown only in the answer to the request; keep it for as long as the request waits.
  const [code, setCode] = useState({ guildId: null, text: null });
  const onState = useCallback(
    (next) => {
      if (next?.code) setCode({ guildId, text: next.code });
      setData(next);
    },
    [guildId, setData]
  );

  // While a copy runs, ask for its progress.
  const busy = data ? isBusy(data.pair, data.progress) : false;
  useEffect(() => {
    if (!busy) return undefined;
    let live = true;
    const timer = setInterval(() => {
      getMirror(guildId)
        .then((next) => live && setData(next))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [busy, guildId, setData]);

  if (error) return <LoadError error={error} what="the mirror" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  return (
    <Reveal>
      <h1 className="v2-section-title">Mirror to Fluxer</h1>
      {data.platform === 'discord' ? (
        <SourceView
          guildId={guildId}
          state={data}
          onState={onState}
          code={code.guildId === guildId ? code.text : null}
        />
      ) : (
        <TargetView guildId={guildId} state={data} onState={onState} />
      )}
    </Reveal>
  );
}

/** Run an action that answers with the new state of the page; a refusal is shown as a message. */
function useAct(onState) {
  const [working, setWorking] = useState(false);
  const act = useCallback(
    async (call, done) => {
      setWorking(true);
      try {
        const next = await call();
        onState(next);
        if (done) notify(done, 'info');
        return next;
      } catch (err) {
        notify(err.message || 'That did not work.');
        return null;
      } finally {
        setWorking(false);
      }
    },
    [onState]
  );
  return { working, act };
}

function StatusPill({ status }) {
  const s = statusOf(status);
  return <span className={`v2-status-pill is-${s.tone}`}>{s.label}</span>;
}

function Stepper({ step }) {
  const at = STEPS.findIndex(([key]) => key === step);
  return (
    <ol className="v2-setup-steps" aria-label="Mirror steps">
      {STEPS.map(([key, label], i) => (
        <li
          key={key}
          className={i < at ? 'is-past' : i === at ? 'is-now' : ''}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="v2-setup-step-n" aria-hidden="true">
            {i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

const Limits = ({ limits }) => (
  <ul className="v2-mirror-facts">
    <li>
      <strong>Copied:</strong> categories and channels with their topics, slowmode, age restriction and
      permission overwrites; roles with their colour, order and permissions; up to {limits.emoji} emoji and{' '}
      {limits.stickers} stickers; the server's name, icon and banner; and Sylo's own settings, with channels
      and roles pointing at the new ones.
    </li>
    <li>
      <strong>Not copied:</strong> members (they join Fluxer themselves), roles given to people, message
      history, threads, overwrites for single members, and anything Fluxer has no counterpart for. The preview
      lists every such case before anything is created.
    </li>
    <li>
      <strong>One way:</strong> Discord is the source. Changes you make to mirrored channels on Fluxer are
      overwritten the next time that item changes on Discord. Sylo never deletes anything on Fluxer that it
      did not create itself.
    </li>
  </ul>
);

// ---------------------------------------------------------------------------------------------------
// The Discord server

function SourceView({ guildId, state, onState, code }) {
  const { pair } = state;
  const step = stepOf(pair);
  return (
    <>
      <p className="v2-field-hint">
        Mirror this server to a Fluxer server: Sylo creates the same categories, channels, roles and emoji
        there and keeps them in step when you change them here.
      </p>
      <Stepper step={step} />
      {!pair ? <AskStep guildId={guildId} state={state} onState={onState} /> : null}
      {pair?.status === 'pending' ? (
        <AgreeStep guildId={guildId} pair={pair} onState={onState} code={code} />
      ) : null}
      {pair?.status === 'ready' ? <PreviewStep guildId={guildId} state={state} onState={onState} /> : null}
      {pair && !['pending', 'ready'].includes(pair.status) ? (
        <RunningStep guildId={guildId} state={state} onState={onState} />
      ) : null}
    </>
  );
}

function AskStep({ guildId, state, onState }) {
  const [target, setTarget] = useState(state.candidates[0]?.id ?? '');
  const { working, act } = useAct(onState);
  const valid = validTargetId(target);

  const ask = () => act(() => requestMirror(guildId, target.trim()));
  return (
    <section className="v2-group" aria-labelledby="mirror-ask">
      <h2 id="mirror-ask" className="v2-group-title">
        Ask for a mirror
      </h2>
      {!state.fluxerConnected ? (
        <Callout tone="info" title="Fluxer is not switched on for this Sylo">
          This Sylo is not connected to Fluxer, so there is nothing to mirror to.
        </Callout>
      ) : null}
      <ol className="v2-mirror-todo">
        <li>On Fluxer, create an empty server for the mirror.</li>
        <li>Invite Sylo to it and give Sylo's role the Administrator permission.</li>
        <li>Enter the id of that Fluxer server below.</li>
      </ol>
      <Limits limits={state.limits} />
      <AccessLock need="edit" note>
        <Field
          label="Fluxer server"
          hint={
            state.candidates.length
              ? 'The Fluxer servers you manage where Sylo is a member are listed. You can also paste a server id.'
              : 'Paste the id of the Fluxer server (copy it with Developer Mode on).'
          }
        >
          <input
            list="mirror-candidates"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Server id"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <datalist id="mirror-candidates">
          {state.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </datalist>
        <div className="v2-setup-actions">
          <button
            type="button"
            className="v2-btn-primary"
            disabled={!valid || working || !state.fluxerConnected}
            onClick={ask}
          >
            Ask for the mirror
          </button>
        </div>
      </AccessLock>
    </section>
  );
}

function AgreeStep({ guildId, pair, onState, code }) {
  const { working, act } = useAct(onState);
  const left = codeLeft(pair.codeExpiresAt);
  return (
    <section className="v2-group" aria-labelledby="mirror-agree">
      <h2 id="mirror-agree" className="v2-group-title">
        Waiting for the Fluxer server
      </h2>
      <p>
        Nothing is created until someone with Edit access on the Fluxer server has agreed. Ask them to open
        Sylo's dashboard for that server, go to <strong>Mirror to Fluxer</strong> and enter the code.
      </p>
      {code ? (
        <p className="v2-mirror-code">
          <code aria-label="The code">{code}</code> <CopyButton text={code} what="code" />
        </p>
      ) : (
        <p className="v2-field-hint">
          The code is shown once, when you ask. If you lost it, ask again for a new one.
        </p>
      )}
      <p className="v2-field-hint">
        {left ? `The code works for another ${left}.` : 'The code has expired.'} Asking again gives a new one.
        If you have Edit access on the Fluxer server yourself, sign in with Fluxer too (Account) and ask
        again: both sides agree at once.
      </p>
      <AccessLock need="edit">
        <div className="v2-setup-actions">
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={working}
            onClick={() => act(() => requestMirror(guildId, pair.otherId), 'A new code was made.')}
          >
            Ask again with a new code
          </button>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={working}
            onClick={() => act(() => mirrorAction(guildId, 'remove'), 'The request was cancelled.')}
          >
            Cancel the request
          </button>
        </div>
      </AccessLock>
    </section>
  );
}

function OptionsForm({ guildId, pair, onState, only }) {
  const { working, act } = useAct(onState);
  return (
    <div className="v2-mirror-options" role="group" aria-label="What is copied">
      {OPTION_ROWS.filter(([key]) => !only || only.includes(key)).map(([key, label]) => (
        <div className="v2-mirror-option" key={key}>
          <span id={`mirror-opt-${key}`}>{label}</span>
          <Switch
            checked={pair.options[key]}
            labelledBy={`mirror-opt-${key}`}
            disabled={working}
            onChange={(on) => act(() => setMirrorOptions(guildId, { [key]: on }))}
          />
        </div>
      ))}
    </div>
  );
}

function PreviewStep({ guildId, state, onState }) {
  const { pair } = state;
  const [shown, setShown] = useState(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const { working, act } = useAct(onState);

  // The options changed: what the preview showed no longer holds.
  const optionsKey = JSON.stringify(pair.options);
  const preview = shown?.key === optionsKey ? shown.data : null;

  async function look() {
    setLoading(true);
    setProblem('');
    try {
      setShown({ key: optionsKey, data: await getMirrorPreview(guildId) });
    } catch (err) {
      setProblem(err.message || 'The preview could not be made.');
    } finally {
      setLoading(false);
    }
  }

  async function start() {
    const ok = await confirmDialog({
      title: `Copy this server to ${pair.otherName ?? 'the Fluxer server'}?`,
      body: 'Sylo creates the channels, roles and emoji you saw in the preview on the Fluxer server. It does not delete anything there. You can pause or stop the mirror at any time.',
      confirmLabel: 'Start the copy',
    });
    if (ok) await act(() => startMirror(guildId));
  }

  return (
    <section className="v2-group" aria-labelledby="mirror-preview">
      <h2 id="mirror-preview" className="v2-group-title">
        Preview{pair.otherName ? ` for ${pair.otherName}` : ''}
      </h2>
      <p className="v2-field-hint">
        Both servers agreed. The preview shows what the copy would do and what cannot be carried over. It
        creates nothing.
      </p>
      <AccessLock need="edit">
        <OptionsForm guildId={guildId} pair={pair} onState={onState} />
      </AccessLock>
      <div className="v2-setup-actions">
        <button type="button" className="v2-btn-primary" onClick={look} disabled={loading}>
          {preview ? 'Look again' : 'Show the preview'}
        </button>
        <AccessLock need="edit">
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={working}
            onClick={() => act(() => mirrorAction(guildId, 'remove'), 'The mirror was removed.')}
          >
            Cancel the mirror
          </button>
        </AccessLock>
      </div>
      {problem ? <p className="v2-note v2-break">{problem}</p> : null}
      {loading ? <p className="v2-state">Reading both servers…</p> : null}
      {preview ? <PreviewResult preview={preview} onStart={start} working={working} /> : null}
    </section>
  );
}

function PreviewResult({ preview, onStart, working }) {
  const lines = summaryLines(preview.summary);
  const groups = groupNotes(preview.notes);
  return (
    <div className="v2-mirror-preview">
      {preview.blockers.map((b) => (
        <Callout key={b.code} tone="warning" title="This cannot start yet">
          {b.message}
        </Callout>
      ))}
      {preview.warnings.map((w) => (
        <Callout key={w.code} tone="info" title="Good to know">
          {w.message}
        </Callout>
      ))}
      <h3 className="v2-mirror-subtitle">What the copy does</h3>
      <ul className="v2-mirror-summary">
        {lines.map((l) => (
          <li key={l.kind}>{l.text}</li>
        ))}
        <li>Last, every copied channel is linked through the bridge (when the bridge is installed).</li>
      </ul>
      <h3 className="v2-mirror-subtitle">What cannot be carried over{groups.length ? '' : ': nothing'}</h3>
      {groups.map((g) => (
        <details key={g.scope} className="v2-mirror-notes">
          <summary>
            {g.title} ({g.items.length})
          </summary>
          <ul>
            {g.items.map((n, i) => (
              <li key={`${n.code}-${n.ref?.id}-${i}`}>{n.message}</li>
            ))}
          </ul>
        </details>
      ))}
      <details className="v2-mirror-notes">
        <summary>Every step ({preview.steps.length})</summary>
        <ul className="v2-mirror-steps">
          {preview.steps.map((s) => (
            <li key={s.key}>
              <span className={`v2-mirror-op is-${s.op}`}>{s.op}</span> {s.name}
              {s.reason ? <span className="v2-field-hint"> ({s.reason})</span> : null}
            </li>
          ))}
        </ul>
      </details>
      <AccessLock need="edit" note>
        <div className="v2-setup-actions">
          <button
            type="button"
            className="v2-btn-primary"
            disabled={!preview.ok || working}
            onClick={onStart}
          >
            Copy to {preview.target?.name ?? 'Fluxer'}
          </button>
        </div>
      </AccessLock>
    </div>
  );
}

function RunningStep({ guildId, state, onState }) {
  const { pair, progress } = state;
  const { working, act } = useAct(onState);
  const [reported, setReported] = useState(null);
  const [again, setAgain] = useState(null);
  const { can } = useAccess();

  // A finished or running copy changes the report: an older one is not shown.
  const reportKey = `${pair.copyRun}:${pair.status}`;
  const report = reported?.key === reportKey ? reported.data : null;

  async function showReport() {
    try {
      setReported({ key: reportKey, data: await getMirrorReport(guildId) });
    } catch (err) {
      notify(err.message || 'The report could not be loaded.');
    }
  }
  const running = pair.status === 'copying' || pair.status === 'live';
  return (
    <section className="v2-group" aria-labelledby="mirror-status">
      <h2 id="mirror-status" className="v2-group-title">
        {pair.otherName ?? 'Fluxer server'} <StatusPill status={pair.status} />
      </h2>
      {pair.status === 'paused' && pair.lastError ? (
        <Callout tone="warning" title="The mirror is paused">
          {pair.lastError}
        </Callout>
      ) : null}
      {pair.status === 'stopped' ? (
        <p className="v2-field-hint">
          The mirror was stopped. What Sylo made on Fluxer is still there. To mirror again, ask for a new
          mirror; the same Fluxer server picks up where this one left off.
        </p>
      ) : null}
      {progress && progress.total > 0 ? (
        <div className="v2-mirror-progress">
          <progress max="100" value={progress.percent} aria-label="Copy progress" />
          <p role="status">{progressText(progress)}</p>
        </div>
      ) : null}
      {pair.status === 'live' ? (
        <p className="v2-field-hint">
          Changes to channels, roles, emoji and stickers on this server are applied on Fluxer
          {progress?.waitingChanges ? ` (${progress.waitingChanges} waiting)` : ''}.
          {pair.copiedAt ? (
            <>
              {' '}
              The first copy finished <Time value={pair.copiedAt} relative />.
            </>
          ) : null}
        </p>
      ) : null}
      <AccessLock need="edit">
        <div className="v2-setup-actions">
          {running ? (
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={working}
              onClick={() => act(() => mirrorAction(guildId, 'pause'), 'The mirror is paused.')}
            >
              Pause
            </button>
          ) : null}
          {pair.status === 'paused' ? (
            <button
              type="button"
              className="v2-btn-primary"
              disabled={working}
              onClick={() => act(() => mirrorAction(guildId, 'resume'), 'The mirror goes on.')}
            >
              Resume
            </button>
          ) : null}
          {['live', 'done'].includes(pair.status) ? (
            <button type="button" className="v2-btn-ghost" onClick={() => setAgain({})}>
              Copy again
            </button>
          ) : null}
          {pair.status !== 'stopped' ? (
            <button
              type="button"
              className="v2-btn-danger-ghost"
              disabled={working}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Stop the mirror?',
                  body: 'Sylo stops copying and following changes. Everything it made on Fluxer stays. Starting again needs both servers to agree again.',
                  confirmLabel: 'Stop',
                  tone: 'danger',
                });
                if (ok) await act(() => mirrorAction(guildId, 'stop'), 'The mirror was stopped.');
              }}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={working}
              onClick={() => act(() => mirrorAction(guildId, 'remove'), 'The mirror was removed.')}
            >
              Remove the mirror
            </button>
          )}
        </div>
      </AccessLock>
      {again ? (
        <AgainPanel
          guildId={guildId}
          onState={onState}
          onClose={() => setAgain(null)}
          canStart={can('edit')}
        />
      ) : null}
      <h3 className="v2-mirror-subtitle">What is mirrored</h3>
      <AccessLock need="edit">
        <OptionsForm guildId={guildId} pair={pair} onState={onState} only={['continuous']} />
      </AccessLock>
      <p className="v2-field-hint">
        Changes on Fluxer to mirrored channels and roles are overwritten the next time that item changes on
        Discord. Sylo never deletes something on Fluxer that it did not create.
      </p>
      {pair.copyRun > 0 ? (
        <>
          <div className="v2-setup-actions">
            <button type="button" className="v2-btn-ghost" onClick={showReport}>
              {report ? 'Refresh the report' : 'Show the report'}
            </button>
          </div>
          {report ? <Report report={report} /> : null}
        </>
      ) : null}
    </section>
  );
}

// "Copy again": the same preview as the first time, then a new copy of what changed.
function AgainPanel({ guildId, onState, onClose }) {
  const [preview, setPreview] = useState(null);
  const { working, act } = useAct(onState);
  useEffect(() => {
    let live = true;
    getMirrorPreview(guildId)
      .then((p) => live && setPreview(p))
      .catch((err) => notify(err.message || 'The preview could not be made.'));
    return () => {
      live = false;
    };
  }, [guildId]);
  return (
    <div className="v2-mirror-again">
      <h3 className="v2-mirror-subtitle">Copy again</h3>
      {!preview ? <p className="v2-state">Reading both servers…</p> : null}
      {preview ? (
        <PreviewResult
          preview={preview}
          working={working}
          onStart={async () => {
            const next = await act(() => startMirror(guildId));
            if (next) onClose();
          }}
        />
      ) : null}
      <button type="button" className="v2-btn-ghost" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function Report({ report }) {
  const groups = groupNotes(report.notes);
  return (
    <div className="v2-mirror-report">
      {report.failed.length ? (
        <>
          <h3 className="v2-mirror-subtitle">Could not be copied ({report.failed.length})</h3>
          <ul>
            {report.failed.map((f) => (
              <li key={`${f.kind}-${f.sourceId}`}>
                {f.name}: {f.detail}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Every step that could be done was done.</p>
      )}
      {groups.map((g) => (
        <details key={g.scope} className="v2-mirror-notes">
          <summary>
            {g.title} ({g.items.length})
          </summary>
          <ul>
            {g.items.map((n, i) => (
              <li key={`${n.code}-${n.ref?.id}-${i}`}>{n.message}</li>
            ))}
          </ul>
        </details>
      ))}
      {report.bridge ? (
        <p className="v2-field-hint">
          Linking channels through the bridge:{' '}
          {report.bridge.status === 'done' ? report.bridge.detail : 'waiting'}.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// The Fluxer server

function TargetView({ guildId, state, onState }) {
  const { pair } = state;
  const { working, act } = useAct(onState);
  const [code, setCode] = useState('');

  if (!pair) {
    return (
      <>
        <p>
          This Fluxer server is not the mirror of a Discord server. To make it one, open Sylo's dashboard for
          the Discord server, go to <strong>Mirror to Fluxer</strong> and ask for a mirror. You will be given
          a code to enter here.
        </p>
        <Limits limits={state.limits} />
      </>
    );
  }
  return (
    <section className="v2-group" aria-labelledby="mirror-target">
      <h2 id="mirror-target" className="v2-group-title">
        Mirror of {pair.otherName ?? 'a Discord server'} <StatusPill status={pair.status} />
      </h2>
      {pair.status === 'pending' ? (
        <>
          <p>
            {pair.requestedBy ? `${pair.requestedBy} asked` : 'Someone asked'} to copy the Discord server{' '}
            <strong>{pair.otherName ?? 'above'}</strong> to this server. Sylo would create channels, roles and
            emoji here, and keep them in step with Discord. Nothing is deleted. If you agree, enter the code
            they gave you.
          </p>
          <AccessLock need="edit" note>
            <Field label="Code" hint="Like K7QW-H2NP. It works once, for an hour.">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="v2-setup-actions">
              <button
                type="button"
                className="v2-btn-primary"
                disabled={working || code.trim().length < 8}
                onClick={() => act(() => acceptMirror(guildId, code.trim()), 'You agreed to the mirror.')}
              >
                Agree to the mirror
              </button>
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={working}
                onClick={() => act(() => mirrorAction(guildId, 'remove'), 'The request was declined.')}
              >
                Decline
              </button>
            </div>
          </AccessLock>
        </>
      ) : (
        <>
          <p className="v2-field-hint">
            The Discord server is the source: what changes there is applied here. Changes made here to
            mirrored channels and roles are overwritten the next time that item changes on Discord. Sylo never
            deletes something here that it did not create. Anyone with Edit access can pause or stop the
            mirror.
          </p>
          {pair.status === 'paused' && pair.lastError ? (
            <Callout tone="warning" title="The mirror is paused">
              {pair.lastError}
            </Callout>
          ) : null}
          <AccessLock need="edit" note>
            <div className="v2-setup-actions">
              {['copying', 'live'].includes(pair.status) ? (
                <button
                  type="button"
                  className="v2-btn-ghost"
                  disabled={working}
                  onClick={() => act(() => mirrorAction(guildId, 'pause'), 'The mirror is paused.')}
                >
                  Pause
                </button>
              ) : null}
              {pair.status === 'paused' ? (
                <button
                  type="button"
                  className="v2-btn-primary"
                  disabled={working}
                  onClick={() => act(() => mirrorAction(guildId, 'resume'), 'The mirror goes on.')}
                >
                  Resume
                </button>
              ) : null}
              {pair.status !== 'stopped' ? (
                <button
                  type="button"
                  className="v2-btn-danger-ghost"
                  disabled={working}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Stop the mirror?',
                      body: 'Sylo stops following the Discord server. What it made here stays.',
                      confirmLabel: 'Stop',
                      tone: 'danger',
                    });
                    if (ok) await act(() => mirrorAction(guildId, 'stop'), 'The mirror was stopped.');
                  }}
                >
                  Stop
                </button>
              ) : null}
            </div>
          </AccessLock>
        </>
      )}
    </section>
  );
}
