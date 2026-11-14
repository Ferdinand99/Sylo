import AutoGrowTextarea from '../components/AutoGrowTextarea.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { tokensFor } from '../placeholders.js';
import { cardTitle } from '../util.js';
import { youtubePreviews } from '../alertPreviews.js';
import { focusedRow, useFocusedKey } from '../useFocusedKey.js';
import '../styles/wp2-alerts.css';

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
// re-saving without touching this field doesn't force a re-resolve.
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

const toForm = (config) => ({ alerts: config.alerts.map(toFormRow) });
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
  const limits = useModuleLimits('youtube-alerts');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('youtube-alerts', {
    toForm,
    fromForm,
  });
  const [focusedKey, focusProps] = useFocusedKey();

  if (status === 'error') return <LoadError error={error} what="YouTube alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, alerts: f.alerts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const addRow = () => setForm((f) => ({ ...f, alerts: [...f.alerts, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, alerts: f.alerts.filter((a) => a.key !== key) }));

  // The previews follow the channel that was edited last (the first one until another is touched).
  const shown = focusedRow(form.alerts, focusedKey);
  const previews = shown
    ? youtubePreviews(shown, { video: data.defaultVideoMessage, live: data.defaultLiveMessage })
    : [];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">YouTube alerts</h1>
        <p className="v2-field-hint">
          Posts in a channel when a YouTube channel uploads a video or goes live. Add a channel by URL or
          @handle; Sylo looks it up when you save.
        </p>
        <HowItWorks>
          <p>
            New uploads come from YouTube's public feed, and "went live" is detected from the channel's live
            page, so no API key is needed. Checks run about every 3 minutes.
          </p>
        </HowItWorks>

        <form onSubmit={save} data-savebar>
          {form.alerts.length === 0 ? (
            <p className="v2-field-hint">No channels yet — add one below.</p>
          ) : null}
          {form.alerts.map((a) => (
            <div className="v2-rule-card" key={a.key} {...focusProps(a.key)}>
              <div className="v2-rule-head">
                <span className="v2-rule-title">{cardTitle(a.name, 'New channel')}</span>
                <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRow(a.key)}>
                  Remove
                </button>
              </div>

              <div className="v2-field-row">
                <div className="v2-field">
                  <label htmlFor={`yt-ch-${a.key}`}>
                    YouTube channel <span className="v2-field-hint">— URL or @handle</span>
                  </label>
                  <input
                    id={`yt-ch-${a.key}`}
                    type="text"
                    placeholder="@MrBeast or a channel URL"
                    value={a.input}
                    onChange={(e) => updateRow(a.key, { input: e.target.value })}
                  />
                </div>
                <div className="v2-field">
                  <label htmlFor={`yt-to-${a.key}`}>Announce in</label>
                  <select
                    id={`yt-to-${a.key}`}
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

              {a.ytChannelId ? (
                <p className="v2-field-hint v2-found-line">Found: {a.name || a.ytChannelId}</p>
              ) : null}

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

              <PlaceholderBar
                fields={[
                  { id: `yt-vid-${a.key}`, label: 'New-video message', tokens: tokensFor('youtube') },
                  { id: `yt-live-${a.key}`, label: 'Went-live message', tokens: tokensFor('youtube') },
                ]}
              />
              <div className="v2-field">
                <label htmlFor={`yt-vid-${a.key}`}>New-video message</label>
                <MentionTextarea
                  as={AutoGrowTextarea}
                  channels={data.channels}
                  roles={data.roles}
                  id={`yt-vid-${a.key}`}
                  rows={2}
                  maxLength={limitOf(limits, 'alerts[].videoMessage').maxLength}
                  placeholder={data.defaultVideoMessage}
                  value={a.videoMessage}
                  onChange={(e) => updateRow(a.key, { videoMessage: e.target.value })}
                />
                <PlaceholderHint
                  fieldId={`yt-vid-${a.key}`}
                  chips={false}
                  tokens={tokensFor('youtube')}
                  value={a.videoMessage}
                  onChange={(videoMessage) => updateRow(a.key, { videoMessage })}
                />
              </div>
              <div className="v2-field">
                <label htmlFor={`yt-live-${a.key}`}>Went-live message</label>
                <MentionTextarea
                  as={AutoGrowTextarea}
                  channels={data.channels}
                  roles={data.roles}
                  id={`yt-live-${a.key}`}
                  rows={2}
                  maxLength={limitOf(limits, 'alerts[].liveMessage').maxLength}
                  placeholder={data.defaultLiveMessage}
                  value={a.liveMessage}
                  onChange={(e) => updateRow(a.key, { liveMessage: e.target.value })}
                />
                <PlaceholderHint
                  fieldId={`yt-live-${a.key}`}
                  chips={false}
                  tokens={tokensFor('youtube')}
                  value={a.liveMessage}
                  onChange={(liveMessage) => updateRow(a.key, { liveMessage })}
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
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={addRow}
            disabled={form.alerts.length >= (limitOf(limits, 'alerts').maxItems ?? Infinity)}
          >
            + Add channel
          </button>
        </form>
        <SendTestButton
          moduleId="youtube-alerts"
          disabled={dirty}
          sample="a sample alert"
          channelName={data.channels.find((c) => c.id === form.alerts[0]?.discordChannelId)?.name}
          note={form.alerts.length > 1 ? 'the first channel in the list' : ''}
        />
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
