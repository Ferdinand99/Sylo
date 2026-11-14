import { useId, useState } from 'react';
import { confirmDialog } from './ConfirmDialog.jsx';
import { TEMPLATES, embedFor, templatesForText } from '../messageTemplates.js';
import '../styles/p6-import.css';

/**
 * "Start from a template": a button that opens the small gallery of built-in templates under it. Picking
 * one calls `onPick(template)`; when the field already holds something, the person is asked before it is
 * replaced. Nothing is saved: the form fills in and is saved the usual way.
 *
 * `templates` is [{ id, name, blurb, sample }]: `sample` is a few words of what the template puts in.
 * Use the helpers below to build the list for a field.
 */
export default function TemplatePicker({ templates, onPick, hasContent = false, what = 'text' }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!templates.length) return null;

  async function pick(t) {
    if (hasContent) {
      const ok = await confirmDialog({
        title: `Replace the ${what}?`,
        body: `The “${t.name}” template replaces what is in here now. Nothing is saved until you save the page.`,
        confirmLabel: 'Replace',
        tone: 'default',
      });
      if (!ok) return;
    }
    setOpen(false);
    onPick(t);
  }

  return (
    <div
      className="v2-template-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className="v2-template-bar">
        <button
          type="button"
          className="v2-btn-ghost"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          Start from a template
        </button>
      </div>
      {open ? (
        <ul id={listId} className="v2-templates" aria-label="Templates">
          {templates.map((t) => (
            <li key={t.id}>
              <button type="button" className="v2-template-card" onClick={() => pick(t)}>
                <span className="v2-template-name">{t.name}</span>
                <span className="v2-template-blurb">{t.blurb}</span>
                {t.sample ? <span className="v2-template-sample">{t.sample}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const shortSample = (s) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);

/** The gallery for an embed message (the builder, the Welcome channel). `tokens`: the page fills {server} in. */
export function embedTemplates({ tokens }) {
  return TEMPLATES.map((t) => {
    const first = embedFor(t, { tokens }).embeds[0];
    return {
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      sample: shortSample([first.title, first.description].filter(Boolean).join('\n')),
      message: embedFor(t, { tokens }),
    };
  });
}

/** The gallery for a text field: only the templates that have a text for `field` (see messageTemplates.js). */
export function textTemplates(field) {
  return templatesForText(field).map((t) => ({
    id: t.id,
    name: t.name,
    blurb: t.blurb,
    sample: shortSample(t.text[field]),
    text: t.text[field],
  }));
}
