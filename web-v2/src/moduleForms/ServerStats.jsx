import { useContext } from 'react';
import { PlatformContext } from '../platformContext.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import EmptyList from '../components/EmptyList.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import UnitInput from '../components/UnitInput.jsx';
import { tokensFor } from '../placeholders.js';

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
  const { platform } = useContext(PlatformContext);
  const limits = useModuleLimits('server-stats');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('server-stats', {
    toForm,
    fromForm,
  });

  // Only Discord is known to rename-limit channels this way; any other platform gets neutral wording.
  const renameLimitOwner = platform === 'discord' ? "Discord's" : "the platform's";

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
        Pick a voice channel (make one, lock it so nobody can join) and Sylo renames it to show a live count,
        e.g. "Members: 1,284". Sylo needs Manage Channels on each one.
      </p>

      <form onSubmit={save} data-savebar>
        {form.channels.length === 0 ? (
          <EmptyList start={{ label: 'Add your first stat channel', onClick: addRow }}>
            Show live numbers, such as the member count, in the name of a channel.
          </EmptyList>
        ) : null}
        {form.channels.map((c) => (
          <div className="v2-rule-card" key={c.key}>
            <div className="v2-rule-head">
              <span className="v2-rule-title">
                {[
                  data.statTypes.find(([t]) => t === c.type)?.[1],
                  data.voiceChannels.find((vc) => vc.id === c.channelId)?.name,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Stat channel'}
              </span>
              <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRow(c.key)}>
                Remove
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

            <PlaceholderBar
              fields={[{ id: `ss-name-${c.key}`, label: 'Channel name', tokens: tokensFor('serverStats') }]}
            />
            <div className="v2-field">
              <label htmlFor={`ss-name-${c.key}`}>
                Channel name{' '}
                <span className="v2-field-hint">— include {'{count}'} where the number goes</span>
              </label>
              <input
                id={`ss-name-${c.key}`}
                type="text"
                maxLength={limitOf(limits, 'channels[].template').maxLength}
                placeholder="Members: {count}"
                value={c.template}
                onChange={(e) => updateRow(c.key, { template: e.target.value })}
              />
              <PlaceholderHint
                fieldId={`ss-name-${c.key}`}
                chips={false}
                tokens={tokensFor('serverStats')}
                value={c.template}
                onChange={(template) => updateRow(c.key, { template })}
              />
              <p className="v2-field-hint">Preview: {c.template.replaceAll('{count}', '1,284')}</p>
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
          <label htmlFor="refreshMinutes">Refresh every</label>
          <UnitInput
            id="refreshMinutes"
            unit="minutes"
            min={limitOf(limits, 'refreshMinutes').min}
            max={limitOf(limits, 'refreshMinutes').max}
            value={form.refreshMinutes}
            onChange={(e) => setForm((f) => ({ ...f, refreshMinutes: Number(e.target.value) }))}
          />
          <p className="v2-field-hint">
            5–60. Lower is more current but closer to {renameLimitOwner} rename limit.
          </p>
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
