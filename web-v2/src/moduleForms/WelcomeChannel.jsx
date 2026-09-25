import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getWelcomeChannel,
  saveWelcomeChannel,
  publishWelcomeChannel,
  unpublishWelcomeChannel,
  createWelcomeReadOnlyChannel,
  ApiError,
} from '../api.js';
import EmbedCard, { EmbedToolbar, pickImage, newKey } from '../components/EmbedCard.jsx';

const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_ITEMS = 10;

function normItem(e = {}) {
  return {
    key: newKey('e'),
    kind: e.kind === 'banner' ? 'banner' : 'embed',
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

function specToForm(spec) {
  return {
    content: String(spec?.content || ''),
    items: (Array.isArray(spec?.embeds) ? spec.embeds : []).map(normItem),
  };
}

function formToSpec(form) {
  return {
    content: form.content,
    embeds: form.items.map((e) => ({
      kind: e.kind,
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
    })),
  };
}

// A "banner" element is just a big image + caption — everything else in
// normaliseEmbedSpec (title/author/fields/footer/…) stays blank for it.
function BannerCard({ item, onChange, toolbar }) {
  return (
    <div className="v2-embed-preview">
      <EmbedToolbar toolbar={toolbar} />
      <div className="v2-embed-bar" style={{ background: item.color }} />
      <div className="v2-embed-body">
        <button
          type="button"
          className={`v2-embed-image-pick${item.image ? ' has' : ''}`}
          onClick={() => onChange({ ...item, image: pickImage(item.image) })}
        >
          {item.image ? <img src={item.image} alt="" /> : <span>+ Add a banner image</span>}
        </button>
        <input
          className="v2-embed-input"
          placeholder="Caption (optional)"
          maxLength={4096}
          value={item.description}
          onChange={(e) => onChange({ ...item, description: e.target.value })}
        />
      </div>
    </div>
  );
}

export default function WelcomeChannel() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [form, setForm] = useState(null);
  const [channelId, setChannelId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  function load() {
    return getWelcomeChannel(guildId)
      .then((d) => {
        setForm(specToForm(d.config.spec));
        setChannelId(d.config.channelId);
        setMessageId(d.config.messageId);
        setChannels(d.channels);
        setState({ loading: false, data: d, error: null });
      })
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

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
          `Couldn't load Welcome channel settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;
  const full = form.items.length >= MAX_ITEMS;

  const addPreset = (id) => {
    if (full) return;
    const p = d.presets.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => ({ ...f, items: [...f.items, normItem(p.defaults)] }));
  };
  const updateItem = (i, next) =>
    setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? next : it)) }));
  const removeItem = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));
  const duplicateItem = (i) =>
    setForm((f) => {
      if (f.items.length >= MAX_ITEMS) return f;
      const copy = normItem({ ...f.items[i], fields: f.items[i].fields.map((field) => ({ ...field })) });
      const items = [...f.items];
      items.splice(i + 1, 0, copy);
      return { ...f, items };
    });
  const moveItem = (i, dir) =>
    setForm((f) => {
      const j = i + dir;
      if (j < 0 || j >= f.items.length) return f;
      const items = [...f.items];
      const [it] = items.splice(i, 1);
      items.splice(j, 0, it);
      return { ...f, items };
    });

  function resetAll() {
    if (!confirm('Clear all elements and the message text?')) return;
    setForm({ content: '', items: [] });
  }

  async function submit(action) {
    setBusy(true);
    setNotice(null);
    try {
      const body = { channelId, spec: formToSpec(form) };
      const { config } =
        action === 'publish'
          ? await publishWelcomeChannel(guildId, body)
          : await saveWelcomeChannel(guildId, body);
      setChannelId(config.channelId);
      setMessageId(config.messageId);
      setNotice({ kind: 'ok', text: action === 'publish' ? 'Published to the channel.' : 'Draft saved.' });
    } catch (err) {
      setNotice({ kind: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function onUnpublish() {
    setBusy(true);
    setNotice(null);
    try {
      const { config } = await unpublishWelcomeChannel(guildId);
      setMessageId(config.messageId);
      setNotice({ kind: 'ok', text: 'Published message removed.' });
    } catch (err) {
      setNotice({ kind: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateChannel() {
    setBusy(true);
    setNotice(null);
    try {
      const { config, channels: chans } = await createWelcomeReadOnlyChannel(guildId);
      setChannelId(config.channelId);
      setChannels(chans);
      setNotice({ kind: 'ok', text: 'Created #welcome.' });
    } catch (err) {
      setNotice({ kind: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="v2-page-head">
        <h1 className="v2-section-title">Welcome channel</h1>
        <button type="button" className="v2-btn-ghost" onClick={resetAll}>
          ↺ Reset to default
        </button>
      </div>
      <p className="v2-field-hint">
        Build one rich message for a dedicated <strong>read-only</strong> channel. Placeholders:{' '}
        <code>{'{server}'}</code>, <code>{'{memberCount}'}</code>.
      </p>

      {notice ? <p className={notice.kind === 'ok' ? 'v2-note' : 'v2-row-warn'}>{notice.text}</p> : null}

      <div className="v2-field-row v2-section-gap">
        <div className="v2-field" style={{ flex: 1, marginBottom: 0 }}>
          <label>Channel</label>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">— select a channel —</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="v2-btn-ghost" disabled={busy} onClick={onCreateChannel}>
          Create read-only #welcome
        </button>
      </div>

      <div className="v2-field">
        <label>
          Message text <span className="v2-field-hint">— optional, shown above the embeds</span>
        </label>
        <textarea
          rows={2}
          placeholder="Welcome to {server}!"
          value={form.content}
          onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
        />
      </div>

      <div className="v2-wc-stage">
        {form.items.length === 0 ? (
          <p className="v2-note">No elements yet — pick one from "Add element" below.</p>
        ) : (
          form.items.map((item, i) => {
            const toolbar = {
              index: i,
              count: form.items.length,
              onMove: (dir) => moveItem(i, dir),
              onDuplicate: () => duplicateItem(i),
              onRemove: () => removeItem(i),
            };
            return item.kind === 'banner' ? (
              <BannerCard
                key={item.key}
                item={item}
                onChange={(next) => updateItem(i, next)}
                toolbar={toolbar}
              />
            ) : (
              <EmbedCard
                key={item.key}
                embed={item}
                onChange={(next) => updateItem(i, next)}
                toolbar={toolbar}
              />
            );
          })
        )}
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Add element</h2>
        <div className="v2-field-row" style={{ flexWrap: 'wrap' }}>
          {d.presets.map((p) => (
            <button
              type="button"
              key={p.id}
              className="v2-btn-ghost"
              disabled={full}
              onClick={() => addPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="v2-field-row v2-section-gap">
        <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => submit('save')}>
          Save draft
        </button>
        <button type="button" className="v2-btn-primary" disabled={busy} onClick={() => submit('publish')}>
          Publish to channel
        </button>
        {messageId ? (
          <button type="button" className="v2-btn-ghost" disabled={busy} onClick={onUnpublish}>
            Remove published message
          </button>
        ) : null}
      </div>
    </form>
  );
}
