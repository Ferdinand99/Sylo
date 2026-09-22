import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(a = {}) {
  return {
    key: newKey(),
    login: a.login || '',
    channelId: a.channelId || '',
    roleId: a.roleId || '',
    message: a.message || '',
    plainText: Boolean(a.plainText),
    onEnd: a.onEnd || 'delete',
  };
}

export default function TwitchAlerts() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'twitch-alerts'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data)
      setForm({ alerts: data.config.alerts.length ? data.config.alerts.map(toFormRow) : [toFormRow()] });
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
          `Couldn't load Twitch alerts settings (${error.message}).`
        )}
      </p>
    );
  }

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        alerts: form.alerts.map((a) => ({
          login: a.login,
          channelId: a.channelId,
          roleId: a.roleId,
          message: a.message,
          plainText: a.plainText,
          onEnd: a.onEnd,
        })),
      };
      const { config } = await saveModuleConfig(guildId, 'twitch-alerts', body);
      setForm({ alerts: config.alerts.length ? config.alerts.map(toFormRow) : [toFormRow()] });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Twitch alerts</h1>
      <p className="v2-field-hint">
        Sylo checks each streamer about once a minute and posts to the chosen channel when they go live.
        Message placeholders: <code>{'{name}'}</code> <code>{'{title}'}</code> <code>{'{game}'}</code>{' '}
        <code>{'{url}'}</code> <code>{'{viewers}'}</code>.
      </p>

      {!data.twitchEnabled ? (
        <p className="v2-warn-text">
          Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET (a free app at dev.twitch.tv/console) for alerts to
          actually fire. You can still configure them here.
        </p>
      ) : null}

      <form onSubmit={onSave}>
        {form.alerts.map((a) => (
          <div className="v2-rule-card" key={a.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Streamer</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRow(a.key)}>
                remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Twitch username</label>
                <input
                  type="text"
                  maxLength={25}
                  placeholder="ninja"
                  value={a.login}
                  onChange={(e) => updateRow(a.key, { login: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label>Announce in</label>
                <select value={a.channelId} onChange={(e) => updateRow(a.key, { channelId: e.target.value })}>
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
                <select value={a.roleId} onChange={(e) => updateRow(a.key, { roleId: e.target.value })}>
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
              <label>Message</label>
              <textarea
                rows={2}
                maxLength={1500}
                placeholder={data.defaultMessage}
                value={a.message}
                onChange={(e) => updateRow(a.key, { message: e.target.value })}
              />
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Post as</label>
                <select
                  value={a.plainText ? 'text' : 'embed'}
                  onChange={(e) => updateRow(a.key, { plainText: e.target.value === 'text' })}
                >
                  <option value="embed">Embed</option>
                  <option value="text">Plain text (no embed)</option>
                </select>
              </div>
              <div className="v2-field">
                <label>When the stream ends</label>
                <select value={a.onEnd} onChange={(e) => updateRow(a.key, { onEnd: e.target.value })}>
                  <option value="delete">Delete the message</option>
                  <option value="edit">Mark it as ended</option>
                  <option value="keep">Leave it</option>
                </select>
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add streamer
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
