import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Music() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'music'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data.config);
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Ładowanie…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Sesja wygasła — <a href="/auth/discord/login">zaloguj się ponownie</a>.
          </>
        ) : (
          `Nie udało się wczytać ustawień muzyki (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'music', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const number = (key, min, max) => (
    <input
      type="number"
      min={min}
      max={max}
      value={form[key]}
      onChange={(e) => set({ [key]: e.target.value === '' ? '' : Number(e.target.value) })}
    />
  );

  return (
    <>
      <h1 className="v2-section-title">Muzyka</h1>
      <p className="v2-field-hint">
        Członkowie na kanale głosowym używają <code>/music play</code> z bezpośrednim linkiem do audio albo{' '}
        <code>/music radio</code> ze stacją zapisaną poniżej. Linki z YouTube i Spotify nie są obsługiwane.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="djRoleId">
            Rola DJ-a <span className="v2-field-hint">— opcjonalnie</span>
          </label>
          <select id="djRoleId" value={form.djRoleId} onChange={(e) => set({ djRoleId: e.target.value })}>
            <option value="">— brak —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Gdy ustawiona, tylko osoby z tą rolą (lub z uprawnieniem Zarządzanie serwerem) mogą puszczać i
            sterować muzyką.
          </p>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.allowUrls}
              onChange={(e) => set({ allowUrls: e.target.checked })}
            />
            Pozwól puszczać dowolne linki do audio
          </label>
        </div>

        <div className="v2-field">
          <label>Maksymalna długość kolejki</label>
          {number('maxQueue', 1, 200)}
        </div>
        <div className="v2-field">
          <label>Maksymalna długość utworu (minuty)</label>
          {number('maxTrackMinutes', 1, 720)}
        </div>
        <div className="v2-field">
          <label>Opuść kanał po bezczynności (minuty)</label>
          {number('idleLeaveMinutes', 1, 60)}
        </div>

        <div className="v2-field">
          <label htmlFor="stations">Stacje radiowe</label>
          <textarea
            id="stations"
            rows={6}
            placeholder="Nazwa | https://stream.example.com/radio.mp3"
            value={form.stations}
            onChange={(e) => set({ stations: e.target.value })}
          />
          <p className="v2-field-hint">
            Jedna stacja w linii w formacie Nazwa | bezpośredni link do strumienia. Playlisty (.m3u, .pls) nie
            są obsługiwane.
          </p>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz'}
          </button>
          {saved ? <span className="v2-field-hint"> Zapisano.</span> : null}
        </div>
      </form>

      <p className="v2-field-hint v2-section-gap">
        Bot potrzebuje uprawnień Wyświetlanie kanału, Połącz i Mów na kanale głosowym.
      </p>
    </>
  );
}
