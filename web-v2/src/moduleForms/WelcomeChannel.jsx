import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getWelcomeChannel,
  saveWelcomeChannel,
  publishWelcomeChannel,
  unpublishWelcomeChannel,
  createWelcomeReadOnlyChannel,
} from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { isDirty } from '../components/formEqual.js';
import { useUnsavedChangesGuard } from '../components/useUnsavedChangesGuard.js';
import EmbedCard, { EmbedToolbar, pickImage, newKey } from '../components/EmbedCard.jsx';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

const HEX_RE = /^#[0-9a-f]{6}$/i;

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
  const embedLimits = useModuleLimits('_embed');
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
          maxLength={limitOf(embedLimits, 'description').maxLength}
          value={item.description}
          onChange={(e) => onChange({ ...item, description: e.target.value })}
        />
      </div>
    </div>
  );
}

export default function WelcomeChannel() {
  const { guildId } = useParams();
  const limits = useModuleLimits('welcome-channel');
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [form, setForm] = useState(null);
  const [channelId, setChannelId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  // What the server last had — the page is "dirty" while channel + message differ.
  const [savedSnapshot, setSavedSnapshot] = useState(null);
  const dirty = form !== null && isDirty({ channelId, form }, savedSnapshot);
  useUnsavedChangesGuard(dirty);

  function load() {
    return getWelcomeChannel(guildId)
      .then((d) => {
        const loaded = specToForm(d.config.spec);
        setForm(loaded);
        setChannelId(d.config.channelId);
        setSavedSnapshot({ channelId: d.config.channelId, form: loaded });
        setMessageId(d.config.messageId);
        setChannels(d.channels);
        setState({ loading: false, data: d, error: null });
      })
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

  if (state.error) return <LoadError error={state.error} what="Welcome channel settings" />;
  if (state.loading || !form) return <p className="v2-state">Loading…</p>;

  const d = state.data;
  const maxItems = limitOf(limits, 'spec.embeds').maxItems ?? Infinity;
  const full = form.items.length >= maxItems;

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
      if (f.items.length >= maxItems) return f;
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

  async function resetAll() {
    const ok = await confirmDialog({
      title: 'Clear the whole message?',
      body: 'Removes every element and the message text from the editor. Nothing changes in the channel until you save or publish.',
      confirmLabel: 'Clear message',
    });
    if (!ok) return;
    setForm({ content: '', items: [] });
  }

  async function submit(action) {
    setBusy(true);
    const sentForm = form;
    try {
      const body = { channelId, spec: formToSpec(form) };
      const { config } =
        action === 'publish'
          ? await publishWelcomeChannel(guildId, body)
          : await saveWelcomeChannel(guildId, body);
      setChannelId(config.channelId);
      setMessageId(config.messageId);
      setSavedSnapshot({ channelId: config.channelId, form: sentForm });
      notify(action === 'publish' ? 'Published to the channel.' : 'Draft saved.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUnpublish() {
    const ok = await confirmDialog({
      title: 'Remove the published message?',
      body: 'The message is deleted from the channel. Your draft stays here, so you can publish it again.',
      confirmLabel: 'Remove message',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { config } = await unpublishWelcomeChannel(guildId);
      setMessageId(config.messageId);
      notify('Published message removed.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateChannel() {
    setBusy(true);
    try {
      const { config, channels: chans } = await createWelcomeReadOnlyChannel(guildId);
      setChannelId(config.channelId);
      setChannels(chans);
      // The server stores the new channel as this message's channel.
      setSavedSnapshot((s) => (s ? { ...s, channelId: config.channelId } : s));
      notify('Created #welcome.', 'info');
    } catch (err) {
      notify(err.message);
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
          maxLength={limitOf(limits, 'spec.content').maxLength}
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

      <div className="v2-composer-actions v2-section-gap">
        <span className="v2-composer-status" aria-live="polite">
          {dirty ? 'Unsaved changes' : ''}
        </span>
        <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => submit('save')}>
          Save draft
        </button>
        <button type="button" className="v2-btn-primary" disabled={busy} onClick={() => submit('publish')}>
          Publish to channel
        </button>
        {messageId ? (
          <button
            type="button"
            className="v2-btn-danger v2-danger-push"
            disabled={busy}
            onClick={onUnpublish}
          >
            Remove published message
          </button>
        ) : null}
      </div>
    </form>
  );
}
