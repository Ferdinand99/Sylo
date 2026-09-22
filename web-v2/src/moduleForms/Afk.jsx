import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

export default function Afk() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'afk'), [guildId]);
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
          `Couldn't load AFK settings (${error.message}).`
        )}
      </p>
    );
  }

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'afk', form);
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
      <h1 className="v2-section-title">AFK</h1>
      <p className="v2-note">
        Members run <code>/afk [reason]</code>. Sylo replies to anyone who mentions them, and clears the
        status automatically when they next send a message.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.setNickname}
              onChange={(e) => setForm((f) => ({ ...f, setNickname: e.target.checked }))}
            />
            Prefix their nickname with <code>[AFK]</code> (needs Manage Nicknames)
          </label>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.mentionReply}
              onChange={(e) => setForm((f) => ({ ...f, mentionReply: e.target.checked }))}
            />
            Reply in-channel when an AFK member is mentioned
          </label>
        </div>

        <div className="v2-field">
          <label>
            Ignore channels <span className="v2-field-hint">— AFK isn't cleared or announced here</span>
          </label>
          <ChipPicker
            kind="channel"
            items={data.channels}
            value={form.ignoreChannels}
            onChange={(ignoreChannels) => setForm((f) => ({ ...f, ignoreChannels }))}
          />
        </div>

        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="v2-field-hint"> Saved.</span> : null}
      </form>
    </>
  );
}
