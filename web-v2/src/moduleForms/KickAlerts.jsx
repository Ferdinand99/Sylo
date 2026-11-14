import AutoGrowTextarea from '../components/AutoGrowTextarea.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import TemplatePicker, { textTemplates } from '../components/TemplatePicker.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { cardTitle } from '../util.js';
import { tokensFor } from '../placeholders.js';
import { streamPreview } from '../alertPreviews.js';
import { focusedRow, useFocusedKey } from '../useFocusedKey.js';

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

const toForm = (config) => ({ alerts: config.alerts.map(toFormRow) });
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
  const limits = useModuleLimits('kick-alerts');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('kick-alerts', {
    toForm,
    fromForm,
  });
  const [focusedKey, focusProps] = useFocusedKey();

  if (status === 'error') return <LoadError error={error} what="Kick alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  // The preview follows the streamer that was edited last (the first one until another is touched).
  const shown = focusedRow(form.alerts, focusedKey);
  const previews = shown ? [streamPreview('kick', shown, data.defaultMessage)] : [];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">Kick alerts</h1>
        <p className="v2-field-hint">
          Sylo checks each streamer about once a minute and posts to the chosen channel when they go live.
        </p>

        {!data.kickEnabled ? (
          <SetupCallout
            what="Kick alerts"
            keys="Kick API keys"
            vars={['KICK_CLIENT_ID', 'KICK_CLIENT_SECRET']}
            where="a free app under kick.com/settings/developer"
          >
            You can set things up now; alerts start once the keys are in.
          </SetupCallout>
        ) : null}

        <form onSubmit={save} data-savebar>
          {form.alerts.length === 0 ? (
            <p className="v2-field-hint">No streamers yet — add one below.</p>
          ) : null}
          {form.alerts.map((a) => (
            <div className="v2-rule-card" key={a.key} {...focusProps(a.key)}>
              <div className="v2-rule-head">
                <span className="v2-rule-title">{cardTitle(a.slug, 'New streamer')}</span>
                <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRow(a.key)}>
                  Remove
                </button>
              </div>

              <div className="v2-field-row">
                <div className="v2-field">
                  <label htmlFor={`kk-user-${a.key}`}>Kick username</label>
                  <input
                    id={`kk-user-${a.key}`}
                    type="text"
                    maxLength={limitOf(limits, 'alerts[].slug').maxLength}
                    placeholder="e.g. streamer_name"
                    value={a.slug}
                    onChange={(e) => updateRow(a.key, { slug: e.target.value })}
                  />
                </div>
                <div className="v2-field">
                  <label htmlFor={`kk-to-${a.key}`}>Announce in</label>
                  <select
                    id={`kk-to-${a.key}`}
                    value={a.channelId}
                    onChange={(e) => updateRow(a.key, { channelId: e.target.value })}
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

              {a.slug && !a.channelId ? (
                <p className="v2-field-hint">This streamer won't be checked until you choose a channel.</p>
              ) : null}

              <PlaceholderBar
                fields={[{ id: `kk-msg-${a.key}`, label: 'Message', tokens: tokensFor('kick') }]}
              />
              <div className="v2-field">
                <label htmlFor={`kk-msg-${a.key}`}>Message</label>
                <MentionTextarea
                  as={AutoGrowTextarea}
                  channels={data.channels}
                  roles={data.roles}
                  id={`kk-msg-${a.key}`}
                  rows={2}
                  maxLength={limitOf(limits, 'alerts[].message').maxLength}
                  placeholder={data.defaultMessage}
                  value={a.message}
                  onChange={(e) => updateRow(a.key, { message: e.target.value })}
                />
                <PlaceholderHint
                  fieldId={`kk-msg-${a.key}`}
                  chips={false}
                  tokens={tokensFor('kick')}
                  value={a.message}
                  onChange={(message) => updateRow(a.key, { message })}
                />
                <TemplatePicker
                  templates={textTemplates('stream')}
                  hasContent={a.message.trim() !== ''}
                  onPick={(t) => updateRow(a.key, { message: t.text })}
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
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={addRow}
            disabled={form.alerts.length >= (limitOf(limits, 'alerts').maxItems ?? Infinity)}
          >
            + Add streamer
          </button>
        </form>
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
