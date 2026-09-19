import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function FreeGames() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'free-games'), [guildId]);
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
          `Couldn't load Free games settings (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'free-games', form);
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
      <h1 className="v2-section-title">Free games</h1>
      <p className="v2-field-hint">
        Sylo checks hourly and posts an embed when a game becomes free to claim — from the Epic Games Store,
        plus Steam / GOG / Fanatical / Humble and more when an <code>ITAD_API_KEY</code> is set. DLC is
        filtered out of announcements; <code>/freegames dlc:true</code> shows free DLC on demand.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="channelId">Announcement channel</label>
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
          <label htmlFor="roleId">
            Ping role <span className="v2-field-hint">— optional</span>
          </label>
          <select id="roleId" value={form.roleId} onChange={(e) => set({ roleId: e.target.value })}>
            <option value="">— none —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      <p className="v2-field-hint v2-section-gap">
        Sylo needs View Channel / Send Messages / Embed Links in that channel.
      </p>
    </>
  );
}
