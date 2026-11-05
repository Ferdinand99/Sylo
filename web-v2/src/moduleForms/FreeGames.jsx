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
        Sylo checks hourly and posts when a game becomes free to claim. Epic Games Store deals are always
        included; Steam, GOG and other stores are included when the bot owner has switched that on. DLC is
        left out of announcements; <code>{cmd('/freegames dlc:true')}</code> shows free DLC on demand.
      </p>

      <form onSubmit={save} data-savebar>
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
          <p className="v2-field-hint">Sylo needs to see the channel, send messages and embed links in it.</p>
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

      <SendTestButton
        moduleId="free-games"
        disabled={dirty}
        sample="a sample announcement"
        channelName={data.channels.find((c) => c.id === form.channelId)?.name}
      />
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
