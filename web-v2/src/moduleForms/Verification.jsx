import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Verification() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'verification'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data.config);
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
          `Couldn't load Verification settings (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'verification', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Verification</h1>
      <p className="v2-field-hint">
        Posts a message with a <strong>Verify</strong> button in the chosen channel. New members click it to
        get the verified role. In <strong>captcha</strong> mode the button sends them a private link to a
        Cloudflare Turnstile check on this dashboard first.
        {!data.turnstileEnabled ? (
          <>
            {' '}
            <span className="v2-row-warn">
              Captcha mode needs <code>TURNSTILE_SITE_KEY</code> and <code>TURNSTILE_SECRET_KEY</code> set —
              until then it behaves like button mode.
            </span>
          </>
        ) : null}
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="mode">Mode</label>
          <select id="mode" value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
            {data.modes.map((m) => (
              <option key={m} value={m}>
                {m === 'captcha' ? 'Captcha (button + Turnstile)' : 'Button only'}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="verifiedRoleId">
            Verified role{' '}
            <span className="v2-field-hint">— granted on success; put Sylo's role above it</span>
          </label>
          <select
            id="verifiedRoleId"
            required
            value={form.verifiedRoleId}
            onChange={(e) => set({ verifiedRoleId: e.target.value })}
          >
            <option value="">— select —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="channelId">Verify channel</label>
          <select
            id="channelId"
            required
            value={form.channelId}
            onChange={(e) => set({ channelId: e.target.value })}
          >
            <option value="">— select —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="title">Message title</label>
          <input
            id="title"
            type="text"
            maxLength={200}
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="message">Message body</label>
          <textarea
            id="message"
            rows={2}
            maxLength={1500}
            value={form.message}
            onChange={(e) => set({ message: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="successMessage">Reply after verifying</label>
          <input
            id="successMessage"
            type="text"
            maxLength={1000}
            value={form.successMessage}
            onChange={(e) => set({ successMessage: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="logChannelId">
            Log channel <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="logChannelId"
            value={form.logChannelId}
            onChange={(e) => set({ logChannelId: e.target.value })}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="kickAfterMinutes">Kick members who don't verify within (minutes, 0 = never)</label>
          <input
            id="kickAfterMinutes"
            type="number"
            min={0}
            max={10080}
            value={form.kickAfterMinutes}
            onChange={(e) => set({ kickAfterMinutes: Number(e.target.value) })}
          />
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      <p className="v2-field-hint v2-section-gap">
        Saving (re)posts the verify message. Sylo needs <strong>Manage Roles</strong>, and — for the kick
        option — <strong>Kick Members</strong>.
      </p>
    </>
  );
}
