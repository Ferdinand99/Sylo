import AutoGrowTextarea from '../components/AutoGrowTextarea.jsx';
import PickerHealth from '../components/PickerHealth.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import EmptyList from '../components/EmptyList.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
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
    login: a.login || '',
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
    login: a.login,
    channelId: a.channelId,
    roleId: a.roleId,
    message: a.message,
    plainText: a.plainText,
    onEnd: a.onEnd,
  })),
});

export default function TwitchAlerts() {
  const limits = useModuleLimits('twitch-alerts');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('twitch-alerts', {
    toForm,
    fromForm,
  });
  const [focusedKey, focusProps] = useFocusedKey();

  if (status === 'error') return <LoadError error={error} what="Twitch alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  // The preview follows the streamer that was edited last (the first one until another is touched).
  const shown = focusedRow(form.alerts, focusedKey);
  const previews = shown ? [streamPreview('twitch', shown, data.defaultMessage)] : [];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">Twitch alerts</h1>
        <p className="v2-field-hint">
          Sylo checks each streamer about once a minute and posts to the chosen channel when they go live.
        </p>

        {!data.twitchEnabled ? (
          <SetupCallout
            what="Twitch alerts"
            keys="Twitch API keys"
            vars={['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']}
            where="a free app at dev.twitch.tv/console"
          >
            You can set things up now; alerts start once the keys are in.
          </SetupCallout>
        ) : null}

        <form onSubmit={save} data-savebar>
          {form.alerts.length === 0 ? (
            <EmptyList start={{ label: 'Add your first streamer', onClick: addRow }}>
              Post in a channel the moment a streamer goes live on Twitch.
            </EmptyList>
          ) : null}
          {form.alerts.map((a) => (
            <div className="v2-rule-card" key={a.key} {...focusProps(a.key)}>
              <div className="v2-rule-head">
                <span className="v2-rule-title">{cardTitle(a.login, 'New streamer')}</span>
                <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRow(a.key)}>
                  Remove
                </button>
              </div>

              <div className="v2-field-row">
                <div className="v2-field">
                  <label htmlFor={`tw-user-${a.key}`}>Twitch username</label>
                  <input
                    id={`tw-user-${a.key}`}
                    type="text"
                    maxLength={limitOf(limits, 'alerts[].login').maxLength}
                    placeholder="ninja"
                    value={a.login}
                    onChange={(e) => updateRow(a.key, { login: e.target.value })}
                  />
                </div>
                <div className="v2-field">
                  <label htmlFor={`tw-to-${a.key}`}>Announce in</label>
                  <select
                    id={`tw-to-${a.key}`}
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
                  <PickerHealth kind="channel" value={a.channelId} embed={!a.plainText} />
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

              {a.login && !a.channelId ? (
                <p className="v2-field-hint">This streamer won't be checked until you choose a channel.</p>
              ) : null}

              <PlaceholderBar
                fields={[{ id: `tw-msg-${a.key}`, label: 'Message', tokens: tokensFor('twitch') }]}
              />
              <div className="v2-field">
                <label htmlFor={`tw-msg-${a.key}`}>Message</label>
                <MentionTextarea
                  as={AutoGrowTextarea}
                  channels={data.channels}
                  roles={data.roles}
                  id={`tw-msg-${a.key}`}
                  rows={2}
                  maxLength={limitOf(limits, 'alerts[].message').maxLength}
                  placeholder={data.defaultMessage}
                  value={a.message}
                  onChange={(e) => updateRow(a.key, { message: e.target.value })}
                />
                <PlaceholderHint
                  fieldId={`tw-msg-${a.key}`}
                  chips={false}
                  tokens={tokensFor('twitch')}
                  value={a.message}
                  onChange={(message) => updateRow(a.key, { message })}
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
        <SendTestButton
          moduleId="twitch-alerts"
          disabled={dirty}
          sample="a sample alert"
          channelName={data.channels.find((c) => c.id === form.alerts[0]?.channelId)?.name}
          note={form.alerts.length > 1 ? 'the first streamer in the list' : ''}
        />
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
