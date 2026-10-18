import { useCmd } from '../platformContext.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

export default function Afk() {
  const cmd = useCmd();
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('afk');

  if (status === 'error') return <LoadError error={error} what="AFK settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">AFK</h1>
      <p className="v2-note">
        Members run <code>{cmd('/afk [reason]')}</code>. Sylo replies to anyone who mentions them, and clears
        the status automatically when they next send a message.
      </p>

      <form onSubmit={save}>
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
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
