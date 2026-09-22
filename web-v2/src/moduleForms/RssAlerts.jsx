import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

// Per-type ref field label/placeholder — mirrors V1's client-side HINTS map
// (rss.ejs's inline script) exactly, same wording.
const HINTS = {
  url: ['Feed URL', 'https://example.com/feed.xml'],
  reddit: ['Subreddit or user', 'r/programming or u/spez'],
  mastodon: ['Handle', '@user@mastodon.social'],
  bluesky: ['Handle', 'name.bsky.social'],
};
const TYPE_LABELS = { url: 'RSS / Atom URL', reddit: 'Reddit', mastodon: 'Mastodon', bluesky: 'Bluesky' };

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(f = {}) {
  return {
    key: newKey(),
    // Bot-managed: assigned server-side on first save, carried through
    // unmodified after that so posted-item dedup state stays attached to
    // this row rather than resetting.
    id: f.id || '',
    type: f.type || 'url',
    ref: f.ref || '',
    channelId: f.channelId || '',
    roleId: f.roleId || '',
    template: f.template || '',
  };
}

export default function RssAlerts() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'rss'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm({ feeds: data.config.feeds.length ? data.config.feeds.map(toFormRow) : [toFormRow()] });
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load RSS alerts settings (${error.message}).`
        )}
      </p>
    );
  }

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, feeds: f.feeds.map((row) => (row.key === key ? { ...row, ...patch } : row)) }));
  const addRow = () => setForm((f) => ({ ...f, feeds: [...f.feeds, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, feeds: f.feeds.filter((row) => row.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        feeds: form.feeds.map((row) => ({
          id: row.id,
          type: row.type,
          ref: row.ref,
          channelId: row.channelId,
          roleId: row.roleId,
          template: row.template,
        })),
      };
      const { config } = await saveModuleConfig(guildId, 'rss', body);
      setForm({ feeds: config.feeds.length ? config.feeds.map(toFormRow) : [toFormRow()] });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">RSS alerts</h1>
      <p className="v2-field-hint">
        Sylo checks each feed every few minutes and posts new items to the chosen channel. Pick a source: a
        raw RSS 2.0 / Atom URL, or a Reddit, Mastodon or Bluesky handle — Sylo turns the handle into that
        platform's feed for you. Template placeholders: <code>{'{title}'}</code> <code>{'{link}'}</code>{' '}
        <code>{'{author}'}</code> <code>{'{feed}'}</code>. The first check only remembers the current items;
        new ones after that are posted (up to 15 feeds).
      </p>

      <form onSubmit={onSave}>
        {form.feeds.map((row) => {
          const hint = HINTS[row.type] || HINTS.url;
          return (
            <div className="v2-rule-card" key={row.key}>
              <div className="v2-rule-head">
                <span className="v2-field-hint">Feed</span>
                <button type="button" className="v2-btn-ghost" onClick={() => removeRow(row.key)}>
                  remove
                </button>
              </div>

              <div className="v2-field-row">
                <div className="v2-field">
                  <label>Source</label>
                  <select value={row.type} onChange={(e) => updateRow(row.key, { type: e.target.value })}>
                    {data.feedTypes.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t] || t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="v2-field">
                  <label>{hint[0]}</label>
                  <input
                    type="text"
                    maxLength={500}
                    placeholder={hint[1]}
                    value={row.ref}
                    onChange={(e) => updateRow(row.key, { ref: e.target.value })}
                  />
                </div>
              </div>

              <div className="v2-field-row">
                <div className="v2-field">
                  <label>Post in</label>
                  <select
                    value={row.channelId}
                    onChange={(e) => updateRow(row.key, { channelId: e.target.value })}
                  >
                    <option value="">— select a channel —</option>
                    {data.channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="v2-field">
                  <label>
                    Ping role <span className="v2-field-hint">— optional</span>
                  </label>
                  <select value={row.roleId} onChange={(e) => updateRow(row.key, { roleId: e.target.value })}>
                    <option value="">— none —</option>
                    {data.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="v2-field">
                <label>
                  Message template <span className="v2-field-hint">— blank uses the default</span>
                </label>
                <textarea
                  rows={2}
                  maxLength={1000}
                  placeholder={data.defaultTemplate}
                  value={row.template}
                  onChange={(e) => updateRow(row.key, { template: e.target.value })}
                />
              </div>
            </div>
          );
        })}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add feed
        </button>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
