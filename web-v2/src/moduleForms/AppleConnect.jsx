import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';

// One channel picker per alert kind; empty means the main channel.
function ChannelPick({ value, onChange, channels }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Channel for this alert">
      <option value="">— main channel —</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
    </select>
  );
}

// Owner-only: the server refuses everyone else, so this page is only ever reached by the owner.
export default function AppleConnect() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'apple-connect'), [guildId]);
  const [form, setForm] = useState(null);
  const [apps, setApps] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setForm(data.config);
      setApps(data.config.apps.join('\n'));
    }
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/login">log in again</a>.
          </>
        ) : (
          `Couldn't load App Store Connect settings (${error.message}).`
        )}
      </p>
    );
  }

  const setKind = (kind, patch) =>
    setForm((f) => ({ ...f, events: { ...f.events, [kind]: { ...f.events[kind], ...patch } } }));
  const ev = form.events;

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = { ...form, apps: apps.split(/[\s,]+/).filter(Boolean) };
      const { config } = await saveModuleConfig(guildId, 'apple-connect', body);
      setForm(config);
      setApps(config.apps.join('\n'));
      setSaved(true);
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">App Store Connect</h1>
      <p className="v2-note">
        Alerts from your Apple Developer account: an app version moving through review, builds and TestFlight,
        new reviews, tester feedback, and certificates about to expire. Checked about every 5 minutes. Only
        the Sylo owner can see this module.
      </p>
      {!data.appleEnabled ? (
        <p className="v2-warn-text">
          Set APPLE_KEY_ID and APPLE_PRIVATE_KEY (and APPLE_ISSUER_ID for a team key) on the bot for alerts to
          fire. You can still configure them here.
        </p>
      ) : null}

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="apple-channel">
            Main channel <span className="v2-field-hint">— used by every alert without its own</span>
          </label>
          <select
            id="apple-channel"
            value={form.channelId}
            onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
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
          <label htmlFor="apple-role">
            Ping role <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="apple-role"
            value={form.roleId}
            onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}
          >
            <option value="">— none —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="apple-apps">
            Apps{' '}
            <span className="v2-field-hint">— App Store Connect app ids, one per line; empty means all</span>
          </label>
          <textarea id="apple-apps" rows={2} value={apps} onChange={(e) => setApps(e.target.value)} />
        </div>

        <p className="v2-field-hint">
          Each alert can go to its own channel; leave it on main channel to use the one above.
        </p>
        <div className="v2-field">
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.versionState.enabled}
                onChange={(e) => setKind('versionState', { enabled: e.target.checked })}
              />
              App version state changes (waiting for review, in review, rejected, ready for sale …)
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.versionState.channelId}
              onChange={(channelId) => setKind('versionState', { channelId })}
            />
          </div>
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.build.enabled}
                onChange={(e) => setKind('build', { enabled: e.target.checked })}
              />
              Builds finished or failed processing
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.build.channelId}
              onChange={(channelId) => setKind('build', { channelId })}
            />
          </div>
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.betaReview.enabled}
                onChange={(e) => setKind('betaReview', { enabled: e.target.checked })}
              />
              TestFlight review started, approved or rejected
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.betaReview.channelId}
              onChange={(channelId) => setKind('betaReview', { channelId })}
            />
          </div>
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.feedback.enabled}
                onChange={(e) => setKind('feedback', { enabled: e.target.checked })}
              />
              TestFlight feedback and crashes
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.feedback.channelId}
              onChange={(channelId) => setKind('feedback', { channelId })}
            />
          </div>
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.reviews.enabled}
                onChange={(e) => setKind('reviews', { enabled: e.target.checked })}
              />
              New customer reviews — only up to
              <input
                type="number"
                min={1}
                max={5}
                value={ev.reviews.maxStars}
                onChange={(e) => setKind('reviews', { maxStars: Number(e.target.value) })}
              />
              stars
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.reviews.channelId}
              onChange={(channelId) => setKind('reviews', { channelId })}
            />
          </div>
          <div className="v2-field-row">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={ev.expiry.enabled}
                onChange={(e) => setKind('expiry', { enabled: e.target.checked })}
              />
              Certificates and profiles expiring — from
              <input
                type="number"
                min={1}
                max={365}
                value={ev.expiry.days}
                onChange={(e) => setKind('expiry', { days: Number(e.target.value) })}
              />
              days before (and at 7 and 1 days; needs a team API key)
            </label>
            <ChannelPick
              channels={data.channels}
              value={ev.expiry.channelId}
              onChange={(channelId) => setKind('expiry', { channelId })}
            />
          </div>
        </div>

        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="v2-field-hint"> Saved.</span> : null}
      </form>
    </>
  );
}
