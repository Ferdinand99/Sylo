import LoadError from '../components/LoadError.jsx';
import PickerHealth from '../components/PickerHealth.jsx';
import SaveBar from '../components/SaveBar.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

// The twelve events in three groups (keys from LOG_EVENTS in src/modules/logging.js); an event the
// list does not know yet still shows, under "Other".
export const EVENT_GROUPS = [
  [
    'Members',
    ['memberJoin', 'memberLeave', 'memberBan', 'memberUnban', 'memberTimeout', 'nickChange', 'roleChange'],
  ],
  ['Messages', ['messageDelete', 'messageEdit', 'messageBulkDelete']],
  ['Server', ['roleCreateDelete', 'channelCreateDelete']],
];
const LABELS = { memberTimeout: 'Timeout added / removed' };

export function groupEvents(logEvents) {
  const byKey = new Map(logEvents);
  const groups = EVENT_GROUPS.map(([title, keys]) => ({
    title,
    events: keys.filter((k) => byKey.has(k)).map((k) => [k, LABELS[k] ?? byKey.get(k)]),
  }));
  const known = new Set(EVENT_GROUPS.flatMap(([, keys]) => keys));
  const other = logEvents.filter(([k]) => !known.has(k));
  if (other.length) groups.push({ title: 'Other', events: other });
  return groups.filter((g) => g.events.length);
}

export default function Logging() {
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('logging');

  if (status === 'error') return <LoadError error={error} what="Server logging settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const setEvent = (key, checked) => setForm((f) => ({ ...f, events: { ...f.events, [key]: checked } }));
  const allOn = data.logEvents.every(([key]) => form.events[key]);
  const setAll = (checked) =>
    setForm((f) => ({
      ...f,
      events: { ...f.events, ...Object.fromEntries(data.logEvents.map(([key]) => [key, checked])) },
    }));

  return (
    <>
      <h1 className="v2-section-title">Server logging</h1>
      <p className="v2-field-hint">
        Posts member, message, role and channel events to a log channel as they happen. This is separate from
        the mod-log channel on the Settings page, which gets the moderation actions (bans, warnings, timeouts)
        taken with Sylo.
      </p>

      <form onSubmit={save} data-savebar>
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
          <PickerHealth kind="channel" value={form.channel} />
        </div>

        <div className="v2-field">
          <div className="v2-field-row v2-wrap-row">
            <label>Events to log</label>
            <button type="button" className="v2-btn-ghost" onClick={() => setAll(!allOn)}>
              {allOn ? 'Clear all' : 'Select all'}
            </button>
          </div>
          {groupEvents(data.logEvents).map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <h3 className="v2-subtitle">{g.title}</h3>
              <div className="v2-check-grid">
                {g.events.map(([key, label]) => (
                  <label className="v2-check" key={key}>
                    <input
                      type="checkbox"
                      checked={Boolean(form.events[key])}
                      onChange={(e) => setEvent(key, e.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </form>
      <SendTestButton moduleId="logging" disabled={dirty} />
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
