import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

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

const toForm = (config) => ({
  refreshMinutes: config.refreshMinutes,
  channels: config.channels.map(toFormRow),
});
const fromForm = (form) => ({
  refreshMinutes: form.refreshMinutes,
  channels: form.channels.map((c) => ({ channelId: c.channelId, type: c.type, template: c.template })),
});

export default function ServerStats() {
  const limits = useModuleLimits('server-stats');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('server-stats', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="Server statistics settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, channels: f.channels.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const addRow = () => setForm((f) => ({ ...f, channels: [...f.channels, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, channels: f.channels.filter((c) => c.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Server statistics</h1>
      <p className="v2-field-hint">
        Pick a voice channel (make one, lock it so nobody can join) and Sylo renames it to show a live count.
        Use <code>{'{count}'}</code> in the name, e.g. "Members: {'{count}'}". Sylo needs Manage Channels on
        each one.
      </p>

      <form onSubmit={save} data-savebar>
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
                maxLength={limitOf(limits, 'channels[].template').maxLength}
                placeholder="Members: {count}"
                value={c.template}
                onChange={(e) => updateRow(c.key, { template: e.target.value })}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={addRow}
          disabled={form.channels.length >= (limitOf(limits, 'channels').maxItems ?? Infinity)}
        >
          + Add stat channel
        </button>

        <div className="v2-field v2-section-gap-sm">
          <label htmlFor="refreshMinutes">Refresh every (minutes)</label>
          <input
            id="refreshMinutes"
            type="number"
            min={limitOf(limits, 'refreshMinutes').min}
            max={limitOf(limits, 'refreshMinutes').max}
            value={form.refreshMinutes}
            onChange={(e) => setForm((f) => ({ ...f, refreshMinutes: Number(e.target.value) }))}
          />
          <p className="v2-field-hint">5–60. Lower is more current but closer to Discord's rename limit.</p>
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
