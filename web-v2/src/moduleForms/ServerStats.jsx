import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(c = {}) {
  return {
    key: newKey(),
    channelId: c.channelId || '',
    type: c.type || 'members',
    template: c.template || 'Members: {count}',
  };
}

export default function ServerStats() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'server-stats'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data)
      setForm({ refreshMinutes: data.config.refreshMinutes, channels: data.config.channels.map(toFormRow) });
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
          `Couldn't load Server statistics settings (${error.message}).`
        )}
      </p>
    );
  }

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, channels: f.channels.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const addRow = () => setForm((f) => ({ ...f, channels: [...f.channels, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, channels: f.channels.filter((c) => c.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        refreshMinutes: form.refreshMinutes,
        channels: form.channels.map((c) => ({ channelId: c.channelId, type: c.type, template: c.template })),
      };
      const { config } = await saveModuleConfig(guildId, 'server-stats', body);
      setForm({ refreshMinutes: config.refreshMinutes, channels: config.channels.map(toFormRow) });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Server statistics</h1>
      <p className="v2-field-hint">
        Pick a voice channel (make one, lock it so nobody can join) and Sylo renames it to show a live count.
        Use <code>{'{count}'}</code> in the name, e.g. "Members: {'{count}'}". Sylo needs Manage Channels on
        each one.
      </p>

      <form onSubmit={onSave}>
        {form.channels.length === 0 ? (
          <p className="v2-field-hint">No stat channels yet — add one below.</p>
        ) : null}
        {form.channels.map((c) => (
          <div className="v2-rule-card" key={c.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Stat channel</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRow(c.key)}>
                remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Voice channel</label>
                <select value={c.channelId} onChange={(e) => updateRow(c.key, { channelId: e.target.value })}>
                  <option value="">— voice channel —</option>
                  {data.voiceChannels.map((vc) => (
                    <option key={vc.id} value={vc.id}>
                      🔊 {vc.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Stat</label>
                <select value={c.type} onChange={(e) => updateRow(c.key, { type: e.target.value })}>
                  {data.statTypes.map(([t, label]) => (
                    <option key={t} value={t}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="v2-field">
              <label>
                Channel name template <span className="v2-field-hint">— must include {'{count}'}</span>
              </label>
              <input
                type="text"
                placeholder="Members: {count}"
                value={c.template}
                onChange={(e) => updateRow(c.key, { template: e.target.value })}
              />
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add stat channel
        </button>

        <div className="v2-field v2-section-gap-sm">
          <label htmlFor="refreshMinutes">Refresh every (minutes)</label>
          <input
            id="refreshMinutes"
            type="number"
            min={5}
            max={60}
            value={form.refreshMinutes}
            onChange={(e) => setForm((f) => ({ ...f, refreshMinutes: Number(e.target.value) }))}
          />
          <p className="v2-field-hint">5–60. Lower is more current but closer to Discord's rename limit.</p>
        </div>

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
