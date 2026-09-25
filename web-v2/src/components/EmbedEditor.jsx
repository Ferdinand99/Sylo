import { useState } from 'react';
import EmbedCard, { autoGrow, newKey } from './EmbedCard.jsx';

// Shared single-embed editor — the V2 counterpart to V1's Alpine
// `embedEditor` (src/web/public/alpine-components.js, `partials/embed-editor.ejs`),
// now built on the same Discord-message-preview card as the Embed messages
// builder (components/EmbedCard.jsx) instead of a second, plainer look.
// Same data model and feature flags (content/author/description/fields/thumb/
// footerIcon/footerKey/defaultColor/vars/placeholders) V1's editor exposed.
//
// Owns its own working state, seeded once from the `spec` prop (like V1's
// `s = cfg.spec` — a starting value, not a controlled prop kept in sync on
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
}) {
  const opts = { content, author, description, fields, thumb, footerIcon, footerKey, timestamp };
  const [e, setE] = useState(() => initialState(spec, { footerKey, defaultColor }));
  // Mirrors V1's Alpine `_last` — inserted tokens go into whichever field the
  // user last focused (title/author/description/footer/content), not a
  // fixed spot, since every consumer (polls, welcome-channel, …) customises
  // a different mix of those fields.
  const [lastFocused, setLastFocused] = useState(content ? 'content' : 'title');

  function set(patch) {
    setE((prev) => {
      const next = { ...prev, ...patch };
      onChange(serialize(next, opts));
      return next;
    });
  }

  function insertVar(token) {
    const current = String(e[lastFocused] ?? '');
    set({ [lastFocused]: (current + (current ? ' ' : '') + token).trim() });
  }

  return (
    <div className="v2-msg-preview">
      <div className="v2-msg-head">
        <div className="v2-msg-avatar">{botName.slice(0, 1)}</div>
        <div className="v2-msg-head-text">
          <span className="v2-msg-botname">{botName}</span>
          <span className="v2-msg-botbadge">BOT</span>
          <span className="v2-msg-time">Today</span>
        </div>
      </div>

      {content ? (
        <textarea
          className="v2-msg-content"
          rows={1}
          maxLength={2000}
          placeholder={placeholders.content || 'Write your message here!'}
          value={e.content}
          onChange={(ev) => {
            autoGrow(ev);
            set({ content: ev.target.value });
          }}
          onFocus={(ev) => {
            autoGrow(ev);
            setLastFocused('content');
          }}
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
        onFieldFocus={setLastFocused}
      />

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
