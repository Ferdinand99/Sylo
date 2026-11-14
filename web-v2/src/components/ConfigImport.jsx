import { useId, useRef, useState } from 'react';
import { applyConfigImport, previewConfigImport } from '../api.js';
import Badge from './Badge.jsx';
import Callout from './Callout.jsx';
import ConfigDiff from './ConfigDiff.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { notify } from '../notify.js';
import '../styles/p6-import.css';

// The server refuses a request body larger than this; saying so here saves the upload.
const MAX_FILE_KB = 256;

const STATUS = {
  change: { tone: 'warning', label: 'Changes' },
  same: { tone: 'neutral', label: 'No changes' },
  skip: { tone: 'neutral', label: 'Not imported' },
};

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : null;
};

/**
 * "Import configuration" on the Settings page, next to the export. Choose the JSON file, see what each module
 * would change, tick what to import, type the confirmation word. Nothing is written until the last step, and
 * every module goes through the same checks as saving its page does (the server does the work).
 *
 * @param {{ guildId: string }} props
 */
export default function ConfigImport({ guildId }) {
  const inputId = useId();
  const input = useRef(null);
  const [stage, setStage] = useState('idle'); // idle | reading | review | applying | done
  const [doc, setDoc] = useState(null);
  const [plan, setPlan] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [results, setResults] = useState(null);
  const [problem, setProblem] = useState(null);

  function reset() {
    setStage('idle');
    setDoc(null);
    setPlan(null);
    setPicked(new Set());
    setResults(null);
    setProblem(null);
    if (input.current) input.current.value = '';
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProblem(null);
    if (file.size > MAX_FILE_KB * 1024) {
      setProblem(`This file is larger than ${MAX_FILE_KB} KB, which is more than a Sylo export holds.`);
      return;
    }
    setStage('reading');
    try {
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('This file is not valid JSON.');
      }
      const next = await previewConfigImport(guildId, parsed);
      setDoc(parsed);
      setPlan(next);
      setPicked(new Set(next.items.filter((i) => i.status === 'change').map((i) => i.key)));
      setStage('review');
    } catch (err) {
      setProblem(err.message);
      setStage('idle');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  const toggle = (key) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function onApply() {
    const keys = plan.items.filter((i) => picked.has(i.key)).map((i) => i.key);
    if (!keys.length) return;
    const ok = await confirmDialog({
      title: `Import ${keys.length} ${keys.length === 1 ? 'item' : 'items'}?`,
      body: (
        <>
          <p>
            This replaces the settings of the ticked items on this server with the ones in the file. Each
            change is written to the audit log.
          </p>
          <p>The file can turn modules on, so check the list before you confirm.</p>
        </>
      ),
      confirmLabel: 'Import',
      tone: 'danger',
      typeToConfirm: plan.confirmWord,
    });
    if (!ok) return;
    setStage('applying');
    try {
      const out = await applyConfigImport(guildId, doc, keys, plan.confirmWord);
      setResults(out.results);
      setStage('done');
      const good = out.results.filter((r) => r.ok).length;
      notify(`Imported ${good} of ${out.results.length}.`, 'info');
    } catch (err) {
      notify(err.message);
      setStage('review');
    }
  }

  const changes = plan?.items.filter((i) => i.status === 'change') ?? [];

  return (
    <div className="v2-row v2-row-stack">
      <div className="v2-row-main">
        <h3>Import configuration</h3>
        <p className="is-wrap">
          Load a configuration file you exported from this or another server. You see what would change for
          each module before anything is written. Channels and roles that this server does not have are left
          empty.
        </p>
        {problem ? (
          <p className="v2-field-error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="v2-row-actions">
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".json,application/json"
          className="v2-import-file"
          onChange={onFile}
          disabled={stage === 'reading' || stage === 'applying'}
        />
        <label htmlFor={inputId} className="v2-btn-ghost v2-import-choose">
          {stage === 'reading' ? 'Reading…' : 'Choose file…'}
        </label>
      </div>

      {plan && stage !== 'done' ? (
        <div className="v2-import-panel">
          <p className="v2-note">
            {plan.source.sameServer
              ? 'Exported from this server'
              : `Exported from another server${plan.source.guildId ? ` (${plan.source.guildId})` : ''}`}
            {when(plan.source.exportedAt) ? `, ${when(plan.source.exportedAt)}` : ''}.{' '}
            {changes.length
              ? `${changes.length} ${changes.length === 1 ? 'item has' : 'items have'} changes.`
              : 'Nothing in it would change this server.'}
          </p>
          <p className="v2-field-hint">{plan.notCarried}</p>
          <ul className="v2-import-items">
            {plan.items.map((item) => (
              <ImportItem
                key={item.key}
                item={item}
                checked={picked.has(item.key)}
                onToggle={() => toggle(item.key)}
              />
            ))}
          </ul>
          <div className="v2-import-actions">
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={stage === 'applying'}
              onClick={() => setPicked(new Set(changes.map((i) => i.key)))}
            >
              Tick all with changes
            </button>
            <button type="button" className="v2-btn-ghost" onClick={() => setPicked(new Set())}>
              Untick all
            </button>
            <span className="v2-import-spacer" />
            <button type="button" className="v2-btn-ghost" onClick={reset} disabled={stage === 'applying'}>
              Cancel
            </button>
            <button
              type="button"
              className="v2-btn-primary"
              disabled={picked.size === 0 || stage === 'applying'}
              onClick={onApply}
            >
              {stage === 'applying'
                ? 'Importing…'
                : `Import ${picked.size} ${picked.size === 1 ? 'item' : 'items'}…`}
            </button>
          </div>
        </div>
      ) : null}

      {results ? (
        <div className="v2-import-panel">
          <p className="v2-note" role="status">
            Imported {results.filter((r) => r.ok).length} of {results.length}.
          </p>
          <ul className="v2-import-items">
            {results.map((r) => (
              <li key={r.key} className="v2-import-item">
                <span className="v2-import-item-main">
                  <span className="v2-import-item-name">{r.label}</span>
                  <Badge tone={r.ok ? 'success' : 'danger'} inline>
                    {r.ok ? 'Imported' : 'Not imported'}
                  </Badge>
                </span>
                {r.error ? <p className="v2-field-hint">{r.error}</p> : null}
              </li>
            ))}
          </ul>
          <div className="v2-import-actions">
            <button type="button" className="v2-btn-ghost" onClick={reset}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImportItem({ item, checked, onToggle }) {
  const id = useId();
  const status = STATUS[item.status] ?? STATUS.skip;
  const canTick = item.status === 'change';
  return (
    <li className="v2-import-item">
      <div className="v2-import-item-main">
        <input id={id} type="checkbox" checked={checked} disabled={!canTick} onChange={onToggle} />
        <label htmlFor={id} className="v2-import-item-name">
          {item.label}
        </label>
        <Badge tone={status.tone} inline>
          {status.label}
        </Badge>
      </div>
      {item.notes.map((n) => (
        <Callout key={n} tone={item.status === 'skip' ? 'info' : 'warning'}>
          {n}
        </Callout>
      ))}
      {item.change ? (
        <details className="v2-import-details">
          <summary>Show what changes</summary>
          <ConfigDiff before={item.change.before} after={item.change.after} names={item.change.names} />
        </details>
      ) : null}
    </li>
  );
}
