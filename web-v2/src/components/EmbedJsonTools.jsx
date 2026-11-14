import { useId, useState } from 'react';
import CopyButton from './CopyButton.jsx';
import Callout from './Callout.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { messageLimits, parseMessageJson, specToDiscordJson } from '../embedJson.js';
import { useModuleLimits } from './useModuleLimits.js';
import '../styles/p6-import.css';

// A message JSON file is a few KB; this only stops someone loading something that is not one.
const MAX_FILE_KB = 256;

/**
 * "Message JSON" under a message editor: the message on the page as Discord message JSON (content and embeds,
 * the shape Discohook uses), to copy or download, and a box to paste or load JSON back in. An import is
 * checked against the server's limits (see embedJson.js) and fills the editor; nothing is saved until the
 * page is saved. Anything the JSON holds that this page cannot carry over is listed, not dropped silently.
 *
/**
 * `links` is false for a page without link buttons (the Welcome channel): the hint says so, and link buttons
 * in imported JSON are listed as not imported.
 * @param {{ getSpec: () => object, onImport: (spec: object) => void, hasContent?: boolean,
 *   fileName?: string, links?: boolean }} props
 */
export default function EmbedJsonTools({
  getSpec,
  onImport,
  hasContent = false,
  fileName = 'message',
  links = true,
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="v2-json-tools v2-section-gap">
      <div className="v2-template-bar">
        <button
          type="button"
          className="v2-btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Message JSON
        </button>
      </div>
      {open ? (
        <JsonPanel
          getSpec={getSpec}
          onImport={onImport}
          hasContent={hasContent}
          fileName={fileName}
          links={links}
        />
      ) : null}
    </div>
  );
}

// Mounted only while open, so the limits are fetched when someone uses the tools.
function JsonPanel({ getSpec, onImport, hasContent, fileName, links }) {
  const embedLimits = useModuleLimits('_embed');
  const messageLimitsOf = useModuleLimits('welcome-channel');
  const limits = messageLimits(embedLimits, messageLimitsOf);
  const [text, setText] = useState(() => JSON.stringify(specToDiscordJson(getSpec()), null, 2));
  const [result, setResult] = useState(null); // { errors } | { warnings, done }
  const areaId = useId();
  const fileId = useId();

  function show() {
    setText(JSON.stringify(specToDiscordJson(getSpec()), null, 2));
    setResult(null);
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_KB * 1024) {
      setResult({
        errors: [`This file is larger than ${MAX_FILE_KB} KB, which is more than a message holds.`],
      });
      return;
    }
    setText(await file.text());
    setResult(null);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/[^\w.-]+/g, '-') || 'message'}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function useJson() {
    const parsed = parseMessageJson(text, limits, { links });
    if (!parsed.ok) {
      setResult({ errors: parsed.errors });
      return;
    }
    if (hasContent) {
      const ok = await confirmDialog({
        title: 'Replace the message?',
        body: 'The message on this page is replaced by the JSON. Nothing is saved until you save the page.',
        confirmLabel: 'Replace',
        tone: 'default',
      });
      if (!ok) return;
    }
    onImport(parsed.spec);
    setResult({ warnings: parsed.warnings, done: true });
  }

  return (
    <div className="v2-field">
      <label htmlFor={areaId}>Message JSON</label>
      <p className="v2-field-hint">
        The same shape as a Discord message, so it works with tools such as Discohook. Copy it to keep or
        share the message, or paste JSON here and use it.{' '}
        {links
          ? 'Link buttons are included; role buttons and menus are not.'
          : 'This message has no buttons, so buttons in the JSON are not imported.'}
      </p>
      <textarea
        id={areaId}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
      />
      {result?.errors ? (
        <div role="alert">
          <Callout tone="warning" title="This JSON can not be used">
            <ul>
              {result.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}
      {result?.done ? (
        <p className="v2-note" role="status">
          Loaded into the page.
        </p>
      ) : null}
      {result?.warnings?.length ? (
        <Callout tone="info" title="Not everything was carried over">
          <ul>
            {result.warnings.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <div className="v2-template-bar">
        <button type="button" className="v2-btn-ghost" onClick={useJson} disabled={!text.trim()}>
          Use this JSON
        </button>
        <button type="button" className="v2-btn-ghost" onClick={show}>
          Show the page as JSON
        </button>
        <CopyButton text={text} what="message JSON" />
        <button
          type="button"
          className="v2-btn-ghost v2-btn-compact"
          onClick={download}
          disabled={!text.trim()}
        >
          Download
        </button>
        <input
          id={fileId}
          type="file"
          accept=".json,application/json"
          className="v2-import-file"
          onChange={onFile}
        />
        <label htmlFor={fileId} className="v2-btn-ghost v2-btn-compact v2-import-choose">
          Choose file…
        </label>
      </div>
    </div>
  );
}
