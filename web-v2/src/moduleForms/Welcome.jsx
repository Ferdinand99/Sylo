import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ToggleSection from '../components/ToggleSection.jsx';

export default function Welcome() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'welcome'), [guildId]);
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
          `Couldn't load Welcome settings (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'welcome', form);
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
      <h1 className="v2-section-title">Welcome &amp; leave</h1>
      <p className="v2-field-hint v2-placeholders">
        Placeholders:{' '}
        {data.placeholders.map((p) => (
          <code key={p}>{p}</code>
        ))}
      </p>

      <form onSubmit={onSave}>
        <ToggleSection
          title="Send a message when a member joins the server"
          on={form.joinEnabled}
          onToggle={() => set({ joinEnabled: !form.joinEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="joinChannel">Channel</label>
            <select
              id="joinChannel"
              value={form.joinChannel}
              onChange={(e) => set({ joinChannel: e.target.value })}
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
            <label htmlFor="joinMessage">Message</label>
            <textarea
              id="joinMessage"
              rows={3}
              placeholder="Welcome {user} to {server}!"
              value={form.joinMessage}
              onChange={(e) => set({ joinMessage: e.target.value })}
            />
          </div>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.useEmbed}
              onChange={(e) => set({ useEmbed: e.target.checked })}
            />
            Send as an embed (uses the server's default embed colour)
          </label>
        </ToggleSection>

        <ToggleSection
          title="Attach a welcome image"
          description="A generated banner with the member's avatar, name and member number, posted with the join message above. Turn on “Send a message when a member joins” for this to show."
          on={form.card}
          onToggle={() => set({ card: !form.card })}
        >
          <div className="v2-field">
            <label htmlFor="cardBackground">
              Background image URL <span className="v2-field-hint">(optional — https, PNG/JPG)</span>
            </label>
            <input
              id="cardBackground"
              type="url"
              placeholder="https://…/banner.png"
              value={form.cardBackground}
              onChange={(e) => set({ cardBackground: e.target.value })}
            />
          </div>
          <img
            className="v2-card-preview"
            src={`/guilds/${guildId}/m/welcome/card-preview?v=${Date.now()}`}
            alt="Welcome image preview"
            loading="lazy"
          />
          <p className="v2-field-hint">Preview uses a sample member — save to apply a new background.</p>
        </ToggleSection>

        <ToggleSection
          title="Send a private message to new members"
          on={form.dmEnabled}
          onToggle={() => set({ dmEnabled: !form.dmEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="dmMessage">DM text</label>
            <textarea
              id="dmMessage"
              rows={3}
              placeholder="Hi {user.name}, welcome to {server}!"
              value={form.dmMessage}
              onChange={(e) => set({ dmMessage: e.target.value })}
            />
          </div>
        </ToggleSection>

        <ToggleSection
          title="Send a message when a member leaves the server"
          on={form.leaveEnabled}
          onToggle={() => set({ leaveEnabled: !form.leaveEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="leaveChannel">Channel</label>
            <select
              id="leaveChannel"
              value={form.leaveChannel}
              onChange={(e) => set({ leaveChannel: e.target.value })}
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
            <label htmlFor="leaveMessage">Message</label>
            <textarea
              id="leaveMessage"
              rows={3}
              placeholder="{user.tag} left the server."
              value={form.leaveMessage}
              onChange={(e) => set({ leaveMessage: e.target.value })}
            />
          </div>
        </ToggleSection>

        <ToggleSection
          title="Give roles to new members"
          description="Assigned automatically on join. Shared with the Reaction roles & autoroles module."
          on={form.autoroleEnabled}
          onToggle={() => set({ autoroleEnabled: !form.autoroleEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="autoroles">Roles</label>
            <select
              id="autoroles"
              multiple
              value={form.autoroles}
              onChange={(e) => set({ autoroles: [...e.target.selectedOptions].map((o) => o.value) })}
            >
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  @{r.name}
                </option>
              ))}
            </select>
          </div>
        </ToggleSection>

        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="v2-field-hint"> Saved.</span> : null}
      </form>

      <div className="v2-row v2-section-gap">
        <div className="v2-row-main">
          <h3>Verify new members with a captcha</h3>
        </div>
        <a className="v2-row-arrow" href={`/guilds/${guildId}/m/verification`}>
          {data.verificationEnabled ? 'On — configure' : 'Set up'} →
        </a>
      </div>
    </>
  );
}
