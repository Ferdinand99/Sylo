import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

export default function Logging() {
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('logging');

  if (status === 'error') return <LoadError error={error} what="Server logging settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const setEvent = (key, checked) => setForm((f) => ({ ...f, events: { ...f.events, [key]: checked } }));

  return (
    <>
      <h1 className="v2-section-title">Server logging</h1>
      <p className="v2-field-hint">
        Posts member / message / role / channel events to a log channel as they happen.
      </p>

      <form onSubmit={save}>
        <div className="v2-field">
          <label htmlFor="channel">Log channel</label>
          <select
            id="channel"
            value={form.channel}
            onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
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
          <label>Events to log</label>
          <div className="v2-check-grid">
            {data.logEvents.map(([key, label]) => (
              <label className="v2-check" key={key}>
                <input
                  type="checkbox"
                  checked={Boolean(form.events[key])}
                  onChange={(e) => setEvent(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
