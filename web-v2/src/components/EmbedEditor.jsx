import { useRef, useState } from 'react';
import AppTag from './AppTag.jsx';
import AutoGrowTextarea from './AutoGrowTextarea.jsx';
import EmbedCard, { newKey } from './EmbedCard.jsx';
import { notify } from '../notify.js';
import { insertAtCursor } from '../placeholders.js';
import { initial } from '../util.js';
import { limitOf } from './useModuleLimits.js';

// Shared single-embed editor, built on the same Discord-message-preview card as the Embed
// messages builder (components/EmbedCard.jsx).
// Data model and feature flags: content/author/description/fields/thumb/
// footerIcon/footerKey/defaultColor/vars/placeholders.
//
// Owns its own working state, seeded once from the `spec` prop (a starting value, not a controlled prop kept in sync on
// every keystroke) — `onChange` is called with the fully server-ready
// serialized object on every edit, the same shape normaliseXxx() functions
// already expect, so the parent form just stores whatever comes back.

const HEX_RE = /^#[0-9a-f]{6}$/i;

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
    [footerKey]: String(s[footerKey] || s.footer || s.footerText || ''),
    footerIcon: String(s.footerIcon || ''),
    timestamp: Boolean(s.timestamp),
    fields: (Array.isArray(s.fields) ? s.fields : []).map((f) => ({
      key: newKey('f'),
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
  out[opts.footerKey] = e[opts.footerKey] ?? '';
  if (opts.footerIcon) out.footerIcon = e.footerIcon;
  if (opts.timestamp) out.timestamp = e.timestamp;
  if (opts.fields) {
    out.fields = e.fields
      .map((f) => ({ name: f.name, value: f.value, inline: f.inline }))
      .filter((f) => f.name || f.value);
  }
  return out;
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
  timestamp = false,
  defaultColor = '#5865f2',
  fixedBody = null,
  vars = [],
  placeholders = {},
  botName = 'Sylo',
  limits = null,
}) {
  const opts = { content, author, description, fields, thumb, footerIcon, footerKey, timestamp };
  const [e, setE] = useState(() => initialState(spec, { footerKey, defaultColor }));
  // Inserted tokens go into whichever field the user last focused (title/author/description/
  // footer/content, or the name or value of an extra field), not a fixed spot, since every consumer
  // (polls, welcome-channel, …) customises a different mix of those fields. That is a field's key
  // ('title', …) or `{ field: <extra field key>, prop: 'name' | 'value' }`.
  const lastFocused = useRef(content ? 'content' : 'title');
  // The text box that field belongs to and where its caret was when it lost focus, so a chip puts
  // the variable at the caret (not at the end), like PlaceholderHint's chips do.
  const lastField = useRef({ el: null, start: undefined, end: undefined });

  function focusField(key) {
    const el = document.activeElement;
    lastField.current = {
      el: el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null,
      start: undefined,
      end: undefined,
    };
    lastFocused.current = key;
  }

  // Focus events bubble in React, so the whole preview sees a field lose focus (clicking a chip
  // would otherwise lose the caret on browsers that ignore the mousedown guard below).
  function rememberCaret(ev) {
    if (ev.target === lastField.current.el) {
      lastField.current.start = ev.target.selectionStart;
      lastField.current.end = ev.target.selectionEnd;
    }
  }

  function set(patch) {
    setE((prev) => {
      const next = { ...prev, ...patch };
      onChange(serialize(next, opts));
      return next;
    });
  }

  const textOf = (target) =>
    typeof target === 'string' ? e[target] : e.fields.find((f) => f.key === target.field)?.[target.prop];
  const setText = (target, value) =>
    typeof target === 'string'
      ? set({ [target]: value })
      : set({ fields: e.fields.map((f) => (f.key === target.field ? { ...f, [target.prop]: value } : f)) });

  function insertVar(token) {
    // The extra field was removed since it was last edited: nowhere to put it.
    const target = lastFocused.current;
    if (typeof target !== 'string' && textOf(target) === undefined) return;
    const { el, start: savedStart, end: savedEnd } = lastField.current;
    const field = el && el.isConnected ? el : null;
    let start = savedStart;
    let end = savedEnd;
    if (field && document.activeElement === field) {
      start = field.selectionStart;
      end = field.selectionEnd;
    }
    const current = String(textOf(target) ?? '');
    // A field that was never clicked into has no caret: the token goes at the end, after a space.
    const hasCaret = field && Number.isInteger(start) && Number.isInteger(end);
    const next = hasCaret
      ? insertAtCursor(current, token, start, end)
      : { value: (current + (current ? ' ' : '') + token).trim(), caret: null };
    if (field && field.maxLength > 0 && next.value.length > field.maxLength) {
      notify(`No room for ${token}: the field is full.`);
      return;
    }
    setText(target, next.value);
    if (next.caret !== null) {
      lastField.current.start = next.caret;
      lastField.current.end = next.caret;
      // The new value is not in the field yet: give the caret back once React has rendered it.
      requestAnimationFrame(() => {
        if (!field.isConnected) return;
        field.focus();
        field.setSelectionRange(next.caret, next.caret);
      });
    }
  }

  return (
    <div className="v2-msg-preview" onBlur={rememberCaret}>
      <div className="v2-msg-head">
        <div className="v2-msg-avatar" aria-hidden="true">
          {initial(botName)}
        </div>
        <div className="v2-msg-head-text">
          <span className="v2-msg-botname">{botName}</span>
          <AppTag />
          <span className="v2-msg-time">Today</span>
        </div>
      </div>

      {content ? (
        <AutoGrowTextarea
          className="v2-msg-content"
          aria-label="Message text"
          maxLength={limitOf(limits, 'content').maxLength}
          placeholder={placeholders.content || 'Write your message here!'}
          value={e.content}
          onChange={(ev) => set({ content: ev.target.value })}
          onFocus={() => focusField('content')}
        />
      ) : null}

      <EmbedCard
        embed={e}
        onChange={(next) => set(next)}
        author={author}
        description={description}
        fields={fields}
        thumb={thumb}
        footerIcon={footerIcon}
        footerKey={footerKey}
        timestamp={timestamp}
        fixedBody={fixedBody}
        placeholders={placeholders}
        onFieldFocus={focusField}
        limits={limits}
      />

      {vars.length ? (
        <div className="v2-embed-vars" role="group" aria-label="Insert a variable">
          Insert:{' '}
          {vars.map((v) => (
            <button
              type="button"
              key={v.token}
              // Keep the focus (and the caret) in the field while the chip is pressed.
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => insertVar(v.token)}
            >
              {v.label}
            </button>
          ))}
          <span className="v2-field-hint v2-embed-vars-hint">
            Click one to add it at the cursor in the field you last edited.
          </span>
        </div>
      ) : null}
    </div>
  );
}
