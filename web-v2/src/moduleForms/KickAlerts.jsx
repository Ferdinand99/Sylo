import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(a = {}) {
  return {
    key: newKey(),
    slug: a.slug || '',
    channelId: a.channelId || '',
    roleId: a.roleId || '',
    message: a.message || '',
    plainText: Boolean(a.plainText),
    onEnd: a.onEnd || 'delete',
  };
}

const toForm = (config) => ({ alerts: config.alerts.length ? config.alerts.map(toFormRow) : [toFormRow()] });
const fromForm = (form) => ({
  alerts: form.alerts.map((a) => ({
    slug: a.slug,
    channelId: a.channelId,
    roleId: a.roleId,
    message: a.message,
    plainText: a.plainText,
    onEnd: a.onEnd,
  })),
});

export default function KickAlerts() {
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('kick-alerts', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="Kick alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Kick alerts</h1>
      <p className="v2-field-hint">
        Sylo checks each streamer about once a minute and posts to the chosen channel when they go live.
        Message placeholders: <code>{'{name}'}</code> <code>{'{title}'}</code> <code>{'{game}'}</code>{' '}
        <code>{'{url}'}</code> <code>{'{viewers}'}</code>.
      </p>

      {!data.kickEnabled ? (
        <p className="v2-warn-text">
          Set KICK_CLIENT_ID and KICK_CLIENT_SECRET (a free app under kick.com/settings/developer) for alerts
          to actually fire. You can still configure them here.
        </p>
      ) : null}

      <form onSubmit={save} data-savebar>
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
                <label>Kick username</label>
                <input
                  type="text"
                  maxLength={25}
                  placeholder="xqc"
                  value={a.slug}
                  onChange={(e) => updateRow(a.key, { slug: e.target.value })}
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
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
