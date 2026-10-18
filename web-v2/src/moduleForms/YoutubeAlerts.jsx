import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function notifyOf(a) {
  if (a.onVideo && a.onLive) return 'both';
  if (a.onLive) return 'live';
  return 'video';
}

// The channel field is a raw @handle/URL the server resolves on save
// (resolveYtChannel — a live network fetch), not something picked from a
// list — `input` starts pre-filled from the already-resolved name/id so
// re-saving without touching this field doesn't force a re-resolve
// (mirrors src/web/views/guild/modules/youtube-alerts.ejs exactly).
function toFormRow(a = {}) {
  return {
    key: newKey(),
    ytChannelId: a.ytChannelId || '',
    name: a.name || '',
    input: a.ytChannelId ? `@${a.name || a.ytChannelId}` : '',
    discordChannelId: a.discordChannelId || '',
    roleId: a.roleId || '',
    notify: notifyOf(a),
    onEnd: a.onEnd || 'delete',
    videoMessage: a.videoMessage || '',
    liveMessage: a.liveMessage || '',
  };
}

const toForm = (config) => ({ alerts: config.alerts.length ? config.alerts.map(toFormRow) : [toFormRow()] });
const fromForm = (form) => ({
  alerts: form.alerts.map((a) => ({
    input: a.input,
    ytChannelId: a.ytChannelId,
    name: a.name,
    discordChannelId: a.discordChannelId,
    roleId: a.roleId,
    notify: a.notify,
    onEnd: a.onEnd,
    videoMessage: a.videoMessage,
    liveMessage: a.liveMessage,
  })),
});

export default function YoutubeAlerts() {
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('youtube-alerts', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="YouTube alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">YouTube alerts</h1>
      <p className="v2-field-hint">
        Add a channel by URL or @handle — Sylo resolves it on save. New uploads come from YouTube's public
        feed; "went live" is detected from the channel's live page (no API key needed). Checks run about every
        3 minutes. Message placeholders: <code>{'{name}'}</code> <code>{'{title}'}</code>{' '}
        <code>{'{url}'}</code>.
      </p>

      <form onSubmit={save}>
        {form.alerts.map((a) => (
          <div className="v2-rule-card" key={a.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Channel</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRow(a.key)}>
                remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>
                  YouTube channel <span className="v2-field-hint">— URL or @handle</span>
                </label>
                <input
                  type="text"
                  placeholder="@MrBeast or a channel URL"
                  value={a.input}
                  onChange={(e) => updateRow(a.key, { input: e.target.value })}
                />
                {a.ytChannelId ? <p className="v2-field-hint">resolved: {a.ytChannelId}</p> : null}
              </div>
              <div className="v2-field">
                <label>Announce in</label>
                <select
                  value={a.discordChannelId}
                  onChange={(e) => updateRow(a.key, { discordChannelId: e.target.value })}
                >
                  <option value="">— select a channel —</option>
                  {data.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Notify on</label>
                <select value={a.notify} onChange={(e) => updateRow(a.key, { notify: e.target.value })}>
                  <option value="both">New videos &amp; going live</option>
                  <option value="video">New videos only</option>
                  <option value="live">Going live only</option>
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
              <label>New-video message</label>
              <textarea
                rows={2}
                maxLength={1500}
                placeholder={data.defaultVideoMessage}
                value={a.videoMessage}
                onChange={(e) => updateRow(a.key, { videoMessage: e.target.value })}
              />
            </div>
            <div className="v2-field">
              <label>Went-live message</label>
              <textarea
                rows={2}
                maxLength={1500}
                placeholder={data.defaultLiveMessage}
                value={a.liveMessage}
                onChange={(e) => updateRow(a.key, { liveMessage: e.target.value })}
              />
            </div>
            <div className="v2-field">
              <label>
                When a livestream ends <span className="v2-field-hint">— the went-live post only</span>
              </label>
              <select value={a.onEnd} onChange={(e) => updateRow(a.key, { onEnd: e.target.value })}>
                <option value="delete">Delete the message</option>
                <option value="edit">Mark it as ended</option>
                <option value="keep">Leave it</option>
              </select>
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add channel
        </button>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
