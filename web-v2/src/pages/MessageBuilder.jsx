import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getComposedMessage, saveComposedMessage, ApiError } from '../api.js';
import EmbedCard, { autoGrow, newKey } from '../components/EmbedCard.jsx';

const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_EMBEDS = 10;
const MAX_LINKS = 5;

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
            onChange={(next) => updateEmbed(i, next)}
            toolbar={{
              index: i,
              count: form.embeds.length,
              onMove: (d) => moveEmbed(i, d),
              onDuplicate: () => duplicateEmbed(i),
              onRemove: () => removeEmbed(i),
            }}
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
