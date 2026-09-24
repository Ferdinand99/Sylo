import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

export default function Tickets() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'tickets'), [guildId]);
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
          `Couldn't load Tickets settings (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'tickets', form);
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
      <h1 className="v2-section-title">Tickets (modmail)</h1>
      <p className="v2-field-hint">
        Members open a ticket by sending the bot a direct message. Staff read and reply from the{' '}
        <a href={`/guilds/${guildId}/tickets`}>Tickets</a> page — replies reach the member as an anonymous
        "Staff" DM.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="greeting">
            Greeting sent when a ticket opens{' '}
            <span className="v2-field-hint">— {'{server}'} is replaced</span>
          </label>
          <textarea
            id="greeting"
            rows={2}
            maxLength={1500}
            placeholder="Thanks for contacting the staff of {server}…"
            value={form.greeting}
            onChange={(e) => set({ greeting: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="closeMessage">Message sent when a ticket is closed</label>
          <textarea
            id="closeMessage"
            rows={2}
            maxLength={1500}
            placeholder="This ticket has been closed…"
            value={form.closeMessage}
            onChange={(e) => set({ closeMessage: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="notifyChannel">
            Staff notification channel{' '}
            <span className="v2-field-hint">— optional, pinged on new tickets/replies</span>
          </label>
          <select
            id="notifyChannel"
            value={form.notifyChannel}
            onChange={(e) => set({ notifyChannel: e.target.value })}
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
          <label>
            Staff roles{' '}
            <span className="v2-field-hint">— may read/reply to tickets even without Manage Server</span>
          </label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.staffRoles}
            onChange={(staffRoles) => set({ staffRoles })}
          />
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.showMessageInAlert}
              onChange={(e) => set({ showMessageInAlert: e.target.checked })}
            />
            Include the ticket's opening message in the staff notification
          </label>
          <p className="v2-field-hint">
            Lets staff see what a ticket is about before opening it — off by default since the message may be
            sensitive.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="transcriptRetentionDays">
            Delete closed tickets after <span className="v2-field-hint">— days; 0 = keep forever</span>
          </label>
          <input
            id="transcriptRetentionDays"
            type="number"
            min={0}
            max={3650}
            value={form.transcriptRetentionDays}
            onChange={(e) => set({ transcriptRetentionDays: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            A daily job removes closed tickets and every message in them once they are older than this. Open
            tickets are never affected.
          </p>
        </div>

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
