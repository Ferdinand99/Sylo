import EmbedEditor from '../components/EmbedEditor.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(s = {}) {
  return {
    key: newKey(),
    channelId: s.channelId || '',
    content: s.content || '',
    embed: s.embed || null,
    repostOnBots: Boolean(s.repostOnBots),
    cooldownSeconds: s.cooldownSeconds || 0,
  };
}

const toForm = (config) => ({ stickies: config.stickies.map(toFormRow) });
const fromForm = (form) => ({
  stickies: form.stickies.map((s) => ({
    channelId: s.channelId,
    content: s.content,
    embed: s.embed,
    repostOnBots: s.repostOnBots,
    cooldownSeconds: s.cooldownSeconds,
  })),
});

export default function Sticky() {
  const limits = useModuleLimits('sticky');
  const { data, form, setForm, status, error, dirty, saving, save, reset, formKey } = useModuleForm(
    'sticky',
    {
      toForm,
      fromForm,
    }
  );

  if (status === 'error') return <LoadError error={error} what="Sticky messages settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, stickies: f.stickies.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  const content = limitOf(limits, 'stickies[].content');
  const cooldown = limitOf(limits, 'stickies[].cooldownSeconds');
  const full = form.stickies.length >= (limitOf(limits, 'stickies').maxItems ?? Infinity);
  const addRow = () => setForm((f) => ({ ...f, stickies: [...f.stickies, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, stickies: f.stickies.filter((s) => s.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Sticky messages</h1>
      <p className="v2-field-hint">
        Each channel can have one sticky message — text, an embed, or both. It is re-posted at the bottom
        whenever someone else writes in that channel.
      </p>

      <form onSubmit={save} data-savebar>
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
                maxLength={content.maxLength}
                placeholder="Message to keep at the bottom… (optional if using an embed)"
                value={s.content}
                onChange={(e) => updateRow(s.key, { content: e.target.value })}
              />
            </div>

            <div className="v2-field">
              {s.embed ? (
                <>
                  <div className="v2-field-row" style={{ marginBottom: 0 }}>
                    <label style={{ marginBottom: 0 }}>Embed</label>
                    <button
                      type="button"
                      className="v2-btn-ghost"
                      onClick={() => updateRow(s.key, { embed: null })}
                    >
                      Remove embed
                    </button>
                  </div>
                  <EmbedEditor
                    key={formKey}
                    spec={s.embed}
                    onChange={(embed) => updateRow(s.key, { embed })}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className="v2-btn-ghost"
                  onClick={() => updateRow(s.key, { embed: {} })}
                >
                  + Add embed
                </button>
              )}
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
                min={cooldown.min}
                max={cooldown.max}
                value={s.cooldownSeconds}
                onChange={(e) => updateRow(s.key, { cooldownSeconds: Number(e.target.value) })}
              />
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow} disabled={full}>
          + Add channel
        </button>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
