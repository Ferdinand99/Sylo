import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Birthdays() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'birthdays'), [guildId]);
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
          `Couldn't load Birthdays settings (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'birthdays', form);
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
      <h1 className="v2-section-title">Birthdays</h1>
      <p className="v2-field-hint">
        Members save their own date with <code>/birthday set</code>. Sylo checks once a day and posts here.
        Placeholders: <code>{'{user}'}</code> <code>{'{age}'}</code> (blank unless a year was given).
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="channel">Announcement channel</label>
          <select id="channel" value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="">— none (no message) —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            rows={2}
            placeholder="🎂 Happy birthday {user}! 🎉"
            value={form.message}
            onChange={(e) => set({ message: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="roleId">
            Birthday role{' '}
            <span className="v2-field-hint">(optional — granted for the day, removed after)</span>
          </label>
          <select id="roleId" value={form.roleId} onChange={(e) => set({ roleId: e.target.value })}>
            <option value="">— none —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                @{r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Sylo's highest role must sit above this one, and it needs <strong>Manage Roles</strong>.
          </p>
        </div>

        <label className="v2-check">
          <input
            type="checkbox"
            checked={form.pingRole}
            onChange={(e) => set({ pingRole: e.target.checked })}
          />
          Ping the birthday role in the announcement
        </label>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
