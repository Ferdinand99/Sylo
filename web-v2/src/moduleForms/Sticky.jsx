import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(s = {}) {
  return {
    key: newKey(),
    channelId: s.channelId || '',
    content: s.content || '',
    repostOnBots: Boolean(s.repostOnBots),
    cooldownSeconds: s.cooldownSeconds || 0,
  };
}

export default function Sticky() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'sticky'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm({ stickies: data.config.stickies.map(toFormRow) });
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
          `Couldn't load Sticky messages settings (${error.message}).`
        )}
      </p>
    );
  }

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, stickies: f.stickies.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  const addRow = () => setForm((f) => ({ ...f, stickies: [...f.stickies, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, stickies: f.stickies.filter((s) => s.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        stickies: form.stickies.map((s) => ({
          channelId: s.channelId,
          content: s.content,
          repostOnBots: s.repostOnBots,
          cooldownSeconds: s.cooldownSeconds,
        })),
      };
      const { config } = await saveModuleConfig(guildId, 'sticky', body);
      setForm({ stickies: config.stickies.map(toFormRow) });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Sticky messages</h1>
      <p className="v2-field-hint">
        Each channel can have one sticky message. It is re-posted at the bottom whenever someone else writes
        in that channel.
      </p>

      <form onSubmit={onSave}>
        {form.stickies.length === 0 ? (
          <p className="v2-field-hint">No sticky messages yet — add a channel below.</p>
        ) : null}
        {form.stickies.map((s) => (
          <div className="v2-rule-card" key={s.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Sticky</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRow(s.key)}>
                remove
              </button>
            </div>

            <div className="v2-field">
              <label>Channel</label>
              <select value={s.channelId} onChange={(e) => updateRow(s.key, { channelId: e.target.value })}>
                <option value="">— channel —</option>
                {data.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="v2-field">
              <label>Message</label>
              <textarea
                rows={3}
                maxLength={2000}
                placeholder="Message to keep at the bottom…"
                value={s.content}
                onChange={(e) => updateRow(s.key, { content: e.target.value })}
              />
            </div>

            <div className="v2-field-row">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={s.repostOnBots}
                  onChange={(e) => updateRow(s.key, { repostOnBots: e.target.checked })}
                />
                Also bump for other apps / webhooks
              </label>
            </div>

            <div className="v2-field">
              <label>
                Min seconds between reposts <span className="v2-field-hint">— 0 = default (4s)</span>
              </label>
              <input
                type="number"
                min={0}
                max={3600}
                value={s.cooldownSeconds}
                onChange={(e) => updateRow(s.key, { cooldownSeconds: Number(e.target.value) })}
              />
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add channel
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
