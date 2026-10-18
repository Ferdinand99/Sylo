import { useCmd } from '../platformContext.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

export default function FreeGames() {
  const cmd = useCmd();
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('free-games');

  if (status === 'error') return <LoadError error={error} what="Free games settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <>
      <h1 className="v2-section-title">Free games</h1>
      <p className="v2-field-hint">
        Sylo checks hourly and posts an embed when a game becomes free to claim — from the Epic Games Store,
        plus Steam / GOG / Fanatical / Humble and more when an <code>ITAD_API_KEY</code> is set. DLC is
        filtered out of announcements; <code>{cmd('/freegames dlc:true')}</code> shows free DLC on demand.
      </p>

      <form onSubmit={save}>
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
      </form>

      <p className="v2-field-hint v2-section-gap">
        Sylo needs View Channel / Send Messages / Embed Links in that channel.
      </p>
      <SendTestButton moduleId="free-games" disabled={dirty} />
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
