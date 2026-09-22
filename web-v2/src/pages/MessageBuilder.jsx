import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getComposedMessage, saveComposedMessage, ApiError } from '../api.js';
import ColorPicker from '../components/ColorPicker.jsx';

const HEX_RE = /^#[0-9a-f]{6}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const MAX_EMBEDS = 10;
const MAX_LINKS = 5;

let uid = 0;
const newKey = (prefix) => `${prefix}${uid++}`;

function normEmbed(e = {}) {
  return {
    key: newKey('e'),
    color: HEX_RE.test(e.color) ? e.color : '#5865f2',
    authorName: String(e.authorName || ''),
    authorIcon: String(e.authorIcon || ''),
    title: String(e.title || ''),
    description: String(e.description || ''),
    image: String(e.image || ''),
    thumbnail: String(e.thumbnail || ''),
    footerText: String(e.footerText || ''),
    footerIcon: String(e.footerIcon || ''),
    fields: (Array.isArray(e.fields) ? e.fields : []).map((f) => ({
      key: newKey('f'),
      name: String(f.name || ''),
      value: String(f.value || ''),
      inline: Boolean(f.inline),
    })),
  };
}

// A composed message's `rows` can also hold a role-select/role-button row —
// built by the Reaction roles module, not this page. Keep whatever isn't a
// plain link-button row untouched so saving here never drops it.
function specToForm(spec) {
  const rows = Array.isArray(spec?.rows) ? spec.rows : [];
  const keepRows = rows.filter(
    (r) => r.type !== 'buttons' || (r.buttons || []).some((b) => b.style !== 'link')
  );
  const links = rows
    .flatMap((r) => (r.type === 'buttons' ? r.buttons || [] : []))
    .filter((b) => b.style === 'link' || b.url)
    .map((b) => ({ label: b.label || '', url: b.url || '', emoji: b.emoji || '' }));
  return {
    content: String(spec?.content || ''),
    embeds: (Array.isArray(spec?.embeds) ? spec.embeds : []).map(normEmbed),
    links,
    keepRows,
  };
}

function formToSpec(form) {
  const embeds = form.embeds.map((e) => ({
    kind: 'embed',
    color: e.color,
    authorName: e.authorName,
    authorIcon: e.authorIcon,
    title: e.title,
    description: e.description,
    image: e.image,
    thumbnail: e.thumbnail,
    footerText: e.footerText,
    footerIcon: e.footerIcon,
    fields: e.fields
      .map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }))
      .filter((f) => f.name || f.value),
  }));
  const buttons = form.links
    .map((b) => ({
      style: 'link',
      label: String(b.label || '').trim(),
      emoji: String(b.emoji || '').trim(),
      url: String(b.url || '').trim(),
    }))
    .filter((b) => b.url && (b.label || b.emoji));
  const rows = buttons.length ? [...form.keepRows, { type: 'buttons', buttons }] : form.keepRows;
  return { content: form.content, embeds, rows };
}

function pickImage(current) {
  const u = window.prompt('Image URL (https://…). Leave blank to remove.', current || '');
  if (u === null) return current;
  const trimmed = String(u).trim();
  return URL_RE.test(trimmed) ? trimmed : '';
}

// Small icon-only toolbar buttons (reorder / duplicate / delete) — MEE6's
// builder uses these instead of labeled buttons; self-contained SVGs rather
// than pulling in V1's sprite, same call Sidebar.jsx already made.
function ToolIcon({ name }) {
  const paths = {
    up: <polyline points="18 15 12 9 6 15" />,
    down: <polyline points="6 9 12 15 18 9" />,
    copy: (
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function AvatarPick({ value, onChange, title }) {
  return (
    <button
      type="button"
      className="v2-embed-avatar-pick"
      title={title}
      onClick={() => onChange(pickImage(value))}
    >
      {value ? <img src={value} alt="" /> : null}
    </button>
  );
}

// Auto-growing so a long title/description doesn't scroll inside its own
// tiny box — it should just make the "message" taller, like Discord itself.
function autoGrow(e) {
  e.target.style.height = 'auto';
  e.target.style.height = `${e.target.scrollHeight}px`;
}

function EmbedCard({ embed, index, count, onChange, onMove, onDuplicate, onRemove }) {
  const set = (patch) => onChange({ ...embed, ...patch });
  const setField = (key, patch) =>
    onChange({ ...embed, fields: embed.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  const addField = () =>
    onChange({
      ...embed,
      fields: [...embed.fields, { key: newKey('f'), name: '', value: '', inline: false }],
    });
  const removeField = (key) => onChange({ ...embed, fields: embed.fields.filter((f) => f.key !== key) });

  return (
    <div className="v2-embed-preview">
      <div className="v2-embed-toolbar">
        <button type="button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ToolIcon name="up" />
        </button>
        <button type="button" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ToolIcon name="down" />
        </button>
        <button type="button" title="Duplicate" onClick={onDuplicate}>
          <ToolIcon name="copy" />
        </button>
        <button type="button" title="Delete" onClick={onRemove}>
          <ToolIcon name="trash" />
        </button>
      </div>

      <div className="v2-embed-bar" style={{ background: embed.color }} />

      <div className="v2-embed-body">
        <ColorPicker value={embed.color} onChange={(color) => set({ color })} />
        <div className="v2-embed-top">
          <div className="v2-embed-main">
            <div className="v2-embed-author-row">
              <AvatarPick
                value={embed.authorIcon}
                onChange={(v) => set({ authorIcon: v })}
                title="Author icon"
              />
              <input
                className="v2-embed-input v2-embed-author"
                placeholder="Author name"
                maxLength={256}
                value={embed.authorName}
                onChange={(e) => set({ authorName: e.target.value })}
              />
            </div>

            <input
              className="v2-embed-input v2-embed-title"
              placeholder="Title"
              maxLength={256}
              value={embed.title}
              onChange={(e) => set({ title: e.target.value })}
            />
            <textarea
              className="v2-embed-input v2-embed-desc"
              placeholder="Write your message here!"
              rows={1}
              maxLength={4096}
              value={embed.description}
              onChange={(e) => {
                autoGrow(e);
                set({ description: e.target.value });
              }}
              onFocus={autoGrow}
            />

            {embed.fields.length > 0 ? (
              <div className="v2-embed-fields-grid">
                {embed.fields.map((f) => (
                  <div className="v2-embed-field-block" key={f.key}>
                    <button
                      type="button"
                      className="v2-embed-field-remove"
                      onClick={() => removeField(f.key)}
                    >
                      ✕
                    </button>
                    <input
                      className="v2-embed-input v2-embed-field-name"
                      placeholder="Field name"
                      maxLength={256}
                      value={f.name}
                      onChange={(e) => setField(f.key, { name: e.target.value })}
                    />
                    <input
                      className="v2-embed-input v2-embed-field-value"
                      placeholder="Field value"
                      maxLength={1024}
                      value={f.value}
                      onChange={(e) => setField(f.key, { value: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            <button type="button" className="v2-embed-addfield" onClick={addField}>
              + Add field
            </button>
          </div>

          <button
            type="button"
            className={`v2-embed-thumb-pick${embed.thumbnail ? ' has' : ''}`}
            onClick={() => set({ thumbnail: pickImage(embed.thumbnail) })}
          >
            {embed.thumbnail ? <img src={embed.thumbnail} alt="" /> : <span>+ thumbnail</span>}
          </button>
        </div>

        <button
          type="button"
          className={`v2-embed-image-pick${embed.image ? ' has' : ''}`}
          onClick={() => set({ image: pickImage(embed.image) })}
        >
          {embed.image ? <img src={embed.image} alt="" /> : <span>+ Add an image</span>}
        </button>

        <div className="v2-embed-footer-row">
          <AvatarPick value={embed.footerIcon} onChange={(v) => set({ footerIcon: v })} title="Footer icon" />
          <input
            className="v2-embed-input v2-embed-footer"
            placeholder="Footer text"
            maxLength={2048}
            value={embed.footerText}
            onChange={(e) => set({ footerText: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

export default function MessageBuilder() {
  const { guildId, id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [state, setState] = useState({ loading: true, error: null });
  const [form, setForm] = useState(null);
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [messageId, setMessageId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getComposedMessage(guildId, id)
      .then((d) => {
        if (cancelled) return;
        setName(d.rec.name);
        setChannelId(d.rec.channelId);
        setMessageId(d.rec.messageId);
        setForm(specToForm(d.rec.spec));
        setChannels(d.channels);
        setState({ loading: false, error: null });
      })
      .catch((error) => !cancelled && setState({ loading: false, error }));
    return () => {
      cancelled = true;
    };
  }, [guildId, id]);

  if (state.loading || !form) return <p className="v2-state">Loading…</p>;

  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load this embed message (${state.error.message}).`
        )}
      </p>
    );
  }

  const addEmbed = () => {
    if (form.embeds.length >= MAX_EMBEDS) return;
    setForm((f) => ({ ...f, embeds: [...f.embeds, normEmbed({})] }));
  };
  const updateEmbed = (i, next) =>
    setForm((f) => ({ ...f, embeds: f.embeds.map((e, idx) => (idx === i ? next : e)) }));
  const removeEmbed = (i) => setForm((f) => ({ ...f, embeds: f.embeds.filter((_, idx) => idx !== i) }));
  const duplicateEmbed = (i) =>
    setForm((f) => {
      if (f.embeds.length >= MAX_EMBEDS) return f;
      const copy = normEmbed({ ...f.embeds[i], fields: f.embeds[i].fields.map((field) => ({ ...field })) });
      const embeds = [...f.embeds];
      embeds.splice(i + 1, 0, copy);
      return { ...f, embeds };
    });
  const moveEmbed = (i, d) =>
    setForm((f) => {
      const j = i + d;
      if (j < 0 || j >= f.embeds.length) return f;
      const embeds = [...f.embeds];
      const [item] = embeds.splice(i, 1);
      embeds.splice(j, 0, item);
      return { ...f, embeds };
    });

  const addLink = () => {
    if (form.links.length >= MAX_LINKS) return;
    setForm((f) => ({ ...f, links: [...f.links, { label: '', emoji: '', url: '' }] }));
  };
  const updateLink = (i, patch) =>
    setForm((f) => ({ ...f, links: f.links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));
  const removeLink = (i) => setForm((f) => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }));

  async function submit(action) {
    setBusy(true);
    setNotice(null);
    try {
      const body = { name, channelId, action, spec: formToSpec(form) };
      const { rec, status, error } = await saveComposedMessage(guildId, id, body);
      if (error) {
        setNotice({ kind: 'bad', text: error });
      } else {
        setNotice({
          kind: 'ok',
          text: {
            saved: 'Draft saved.',
            sent: 'Published to the channel.',
            updated: 'Published message updated.',
          }[status],
        });
        setChannelId(rec.channelId);
        setMessageId(rec.messageId);
        if (isNew) navigate(`/guilds/${guildId}/messages/${rec.id}`, { replace: true });
      }
    } catch (err) {
      setNotice({ kind: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="v2-page-head">
        <input
          type="text"
          className="v2-mb-name"
          maxLength={100}
          placeholder="Untitled embed"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="v2-field-row">
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() => navigate(`/guilds/${guildId}/messages`)}
          >
            Discard
          </button>
          <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => submit('save')}>
            Save draft
          </button>
          <button type="button" className="v2-btn-primary" disabled={busy} onClick={() => submit('publish')}>
            {messageId ? 'Update published' : 'Publish'}
          </button>
        </div>
      </div>

      {notice ? <p className={notice.kind === 'ok' ? 'v2-note' : 'v2-row-warn'}>{notice.text}</p> : null}

      <div className="v2-field v2-section-gap">
        <label htmlFor="channelId">Channel</label>
        <select id="channelId" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">— select a channel —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        {messageId ? (
          <p className="v2-field-hint">
            Published — "Update published" edits the posted message; changing the channel posts a fresh one.
          </p>
        ) : null}
      </div>

      <h2 className="v2-group-title v2-section-gap">Message</h2>
      <p className="v2-field-hint">
        This is a live preview — click straight into any part of it to edit. To ping a role, type it into the
        message text as {'<@&ROLE_ID>'}; mentions placed inside an embed don't notify anyone.
      </p>

      <div className="v2-msg-preview">
        <div className="v2-msg-head">
          <div className="v2-msg-avatar">S</div>
          <div className="v2-msg-head-text">
            <span className="v2-msg-botname">Sylo</span>
            <span className="v2-msg-botbadge">BOT</span>
            <span className="v2-msg-time">Today</span>
          </div>
        </div>
        <textarea
          className="v2-msg-content"
          rows={1}
          maxLength={2000}
          placeholder="Write your message here!"
          value={form.content}
          onChange={(e) => {
            autoGrow(e);
            setForm((f) => ({ ...f, content: e.target.value }));
          }}
          onFocus={autoGrow}
        />

        {form.embeds.map((embed, i) => (
          <EmbedCard
            key={embed.key}
            embed={embed}
            index={i}
            count={form.embeds.length}
            onChange={(next) => updateEmbed(i, next)}
            onMove={(d) => moveEmbed(i, d)}
            onDuplicate={() => duplicateEmbed(i)}
            onRemove={() => removeEmbed(i)}
          />
        ))}

        <button
          type="button"
          className="v2-embed-add"
          disabled={form.embeds.length >= MAX_EMBEDS}
          onClick={addEmbed}
        >
          + Add embed
        </button>
      </div>

      <h2 className="v2-group-title v2-section-gap">
        Link buttons <span className="v2-field-hint">— optional, up to {MAX_LINKS}</span>
      </h2>
      {form.links.map((link, i) => (
        <div className="v2-field-row v2-section-gap-sm" key={i}>
          <input
            type="text"
            placeholder="Label"
            maxLength={80}
            value={link.label}
            onChange={(e) => updateLink(i, { label: e.target.value })}
          />
          <input
            type="text"
            placeholder="emoji"
            maxLength={64}
            value={link.emoji}
            onChange={(e) => updateLink(i, { emoji: e.target.value })}
          />
          <input
            type="text"
            placeholder="https://…"
            value={link.url}
            onChange={(e) => updateLink(i, { url: e.target.value })}
          />
          <button type="button" className="v2-btn-ghost" onClick={() => removeLink(i)}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="v2-btn-ghost v2-section-gap-sm"
        disabled={form.links.length >= MAX_LINKS}
        onClick={addLink}
      >
        + Add link button
      </button>
    </form>
  );
}
