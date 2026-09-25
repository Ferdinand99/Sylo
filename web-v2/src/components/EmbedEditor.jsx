import { useState } from 'react';

// Shared WYSIWYG-ish embed editor — the V2 counterpart to V1's Alpine
// `embedEditor` (src/web/public/alpine-components.js, `partials/embed-editor.ejs`).
// Same data model and feature flags (content/author/description/fields/thumb/
// footerIcon/footerKey/defaultColor/vars/placeholders), same live Discord-embed
// look, but built as a real React component instead of contenteditable divs +
// a hidden-input hack — no cursor-jump bugs, and image URLs are plain inline
// fields instead of a native window.prompt() popup.
//
// Owns its own working state, seeded once from the `spec` prop (like Alpine's
// `s = cfg.spec` — a starting value, not a controlled prop kept in sync on
// every keystroke) — `onChange` is called with the fully server-ready
// serialized object on every edit, same shape normaliseXxx() functions
// already expect, so the parent form just stores whatever comes back.

const URL_RE = /^https?:\/\/\S+$/i;
const HEX_RE = /^#[0-9a-f]{6}$/i;

let fieldSeq = 0;
const newFieldId = () => `ee-f${fieldSeq++}`;

function initialState(spec, { footerKey, defaultColor }) {
  const s = spec && typeof spec === 'object' ? spec : {};
  return {
    content: String(s.content || ''),
    color: HEX_RE.test(s.color) ? s.color : defaultColor,
    authorName: String(s.authorName || ''),
    authorIcon: String(s.authorIcon || ''),
    title: String(s.title || ''),
    description: String(s.description || ''),
    image: String(s.image || ''),
    thumbnail: String(s.thumbnail || ''),
    footer: String(s[footerKey] || s.footer || s.footerText || ''),
    footerIcon: String(s.footerIcon || ''),
    fields: (Array.isArray(s.fields) ? s.fields : []).map((f) => ({
      id: newFieldId(),
      name: String(f.name || ''),
      value: String(f.value || ''),
      inline: Boolean(f.inline),
    })),
  };
}

function serialize(e, opts) {
  const out = { kind: 'embed', color: e.color, title: e.title, image: e.image };
  if (opts.content) out.content = e.content;
  if (opts.author) {
    out.authorName = e.authorName;
    out.authorIcon = e.authorIcon;
  }
  if (opts.description) out.description = e.description;
  if (opts.thumb) out.thumbnail = e.thumbnail;
  out[opts.footerKey] = e.footer;
  if (opts.footerIcon) out.footerIcon = e.footerIcon;
  if (opts.fields) {
    out.fields = e.fields
      .map((f) => ({ name: f.name, value: f.value, inline: f.inline }))
      .filter((f) => f.name || f.value);
  }
  return out;
}

function ImageSlot({ label, value, onChange, square }) {
  const [open, setOpen] = useState(false);

  if (!open && !value) {
    return (
      <button type="button" className="v2-embed-imgbtn" onClick={() => setOpen(true)}>
        + {label}
      </button>
    );
  }

  return (
    <div className={`v2-embed-imgslot${square ? ' v2-embed-imgslot-sq' : ''}`}>
      {value && !open ? <img src={value} alt="" /> : null}
      {open ? (
        <input
          type="text"
          className="v2-embed-imginput"
          placeholder="https://…"
          defaultValue={value}
          autoFocus
          onBlur={(ev) => {
            const v = ev.target.value.trim();
            onChange(v && URL_RE.test(v) ? v : '');
            setOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="v2-embed-imgedit"
          onClick={() => setOpen(true)}
          title={`Change ${label.toLowerCase()}`}
        >
          ✎
        </button>
      )}
    </div>
  );
}

export default function EmbedEditor({
  spec,
  onChange,
  content = false,
  author = true,
  description = true,
  fields = true,
  thumb = true,
  footerIcon = true,
  footerKey = 'footerText',
  defaultColor = '#5865f2',
  fixedBody = null,
  vars = [],
  placeholders = {},
}) {
  const opts = { content, author, description, fields, thumb, footerIcon, footerKey };
  const [e, setE] = useState(() => initialState(spec, { footerKey, defaultColor }));
  const [lastFocused, setLastFocused] = useState('title');

  function set(patch) {
    setE((prev) => {
      const next = { ...prev, ...patch };
      onChange(serialize(next, opts));
      return next;
    });
  }

  function addField() {
    set({ fields: [...e.fields, { id: newFieldId(), name: '', value: '', inline: false }] });
  }
  function updateField(id, patch) {
    set({ fields: e.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  }
  function removeField(id) {
    set({ fields: e.fields.filter((f) => f.id !== id) });
  }

  function insertVar(token) {
    const current = String(e[lastFocused] ?? '');
    set({ [lastFocused]: (current + (current ? ' ' : '') + token).trim() });
  }

  return (
    <div className="v2-embed-editor">
      {content ? (
        <textarea
          className="v2-embed-content"
          rows={2}
          placeholder={placeholders.content || 'Message above the embed — optional'}
          value={e.content}
          onFocus={() => setLastFocused('content')}
          onChange={(ev) => set({ content: ev.target.value })}
        />
      ) : null}

      <div className="v2-embed" style={{ '--v2-embed-color': e.color }}>
        <label className="v2-embed-colorwrap" title="Embed colour">
          <input type="color" value={e.color} onChange={(ev) => set({ color: ev.target.value })} />
        </label>

        {thumb ? (
          <div className="v2-embed-thumb">
            <ImageSlot label="Thumbnail" value={e.thumbnail} onChange={(v) => set({ thumbnail: v })} square />
          </div>
        ) : null}

        <div className="v2-embed-body">
          {author ? (
            <div className="v2-embed-row">
              <ImageSlot
                label="Author icon"
                value={e.authorIcon}
                onChange={(v) => set({ authorIcon: v })}
                square
              />
              <input
                type="text"
                className="v2-embed-field v2-embed-author"
                placeholder={placeholders.author || 'Header'}
                value={e.authorName}
                onFocus={() => setLastFocused('authorName')}
                onChange={(ev) => set({ authorName: ev.target.value })}
              />
            </div>
          ) : null}

          <input
            type="text"
            className="v2-embed-field v2-embed-title"
            placeholder={placeholders.title || 'Title'}
            value={e.title}
            onFocus={() => setLastFocused('title')}
            onChange={(ev) => set({ title: ev.target.value })}
          />

          {description ? (
            <textarea
              className="v2-embed-field v2-embed-desc"
              rows={2}
              placeholder={placeholders.description || 'Description'}
              value={e.description}
              onFocus={() => setLastFocused('description')}
              onChange={(ev) => set({ description: ev.target.value })}
            />
          ) : null}

          {fixedBody}

          {fields ? (
            <div className="v2-embed-fields">
              {e.fields.map((f) => (
                <div className="v2-embed-field-row" key={f.id}>
                  <input
                    type="text"
                    placeholder="Field name"
                    value={f.name}
                    onChange={(ev) => updateField(f.id, { name: ev.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Field value"
                    value={f.value}
                    onChange={(ev) => updateField(f.id, { value: ev.target.value })}
                  />
                  <button
                    type="button"
                    className="v2-embed-x"
                    onClick={() => removeField(f.id)}
                    title="Remove field"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="v2-btn-ghost" onClick={addField}>
                + Add field
              </button>
            </div>
          ) : null}

          <ImageSlot label="Add an image" value={e.image} onChange={(v) => set({ image: v })} />

          <div className="v2-embed-row v2-embed-footrow">
            {footerIcon ? (
              <ImageSlot
                label="Footer icon"
                value={e.footerIcon}
                onChange={(v) => set({ footerIcon: v })}
                square
              />
            ) : null}
            <input
              type="text"
              className="v2-embed-field"
              placeholder={placeholders.footer || 'Footer'}
              value={e.footer}
              onFocus={() => setLastFocused('footer')}
              onChange={(ev) => set({ footer: ev.target.value })}
            />
          </div>
        </div>
      </div>

      {vars.length ? (
        <div className="v2-embed-vars">
          Insert:{' '}
          {vars.map((v) => (
            <button type="button" key={v.token} onClick={() => insertVar(v.token)}>
              {v.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
