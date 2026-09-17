import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getGuildSettings, saveGuildSettings, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Settings() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getGuildSettings(guildId), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-syncs whenever fresh data lands (a new guild, or after a save) — not
  // on every form edit, since this only re-runs when `data` itself changes.
  useEffect(() => {
    if (data) {
      setForm({
        modlogChannelId: data.modlogChannelId,
        embedColor: data.embedColorHex,
        botMasterRoleIds: data.botMasterRoleIds,
      });
    }
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
          `Couldn't load settings (${error.message}).`
        )}
      </p>
    );
  }

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await saveGuildSettings(guildId, form);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onResetColor() {
    setSaving(true);
    setSaved(false);
    try {
      await saveGuildSettings(guildId, { ...form, embedColorReset: true });
      const fresh = await getGuildSettings(guildId);
      setForm((f) => ({ ...f, embedColor: fresh.embedColorHex }));
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Settings</h1>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="modlog">Mod-log channel</label>
          <select
            id="modlog"
            value={form.modlogChannelId}
            onChange={(e) => setForm((f) => ({ ...f, modlogChannelId: e.target.value }))}
          >
            <option value="">— off —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">Every moderation action posts an embed here.</p>
        </div>

        <div className="v2-field">
          <label htmlFor="masters">Bot master roles</label>
          <select
            id="masters"
            multiple
            value={form.botMasterRoleIds}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                botMasterRoleIds: [...e.target.selectedOptions].map((o) => o.value),
              }))
            }
          >
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                @{r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Ctrl/Cmd-click to select several. Roles with Administrator already have dashboard access and don't
            need to be added here.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="color">Default embed colour</label>
          <div className="v2-field-row">
            <input
              id="color"
              type="color"
              className="v2-color-input"
              value={form.embedColor}
              onChange={(e) => setForm((f) => ({ ...f, embedColor: e.target.value }))}
            />
            <span>{form.embedColor}</span>
            <button type="button" className="v2-btn-ghost" onClick={onResetColor} disabled={saving}>
              Reset to default
            </button>
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
