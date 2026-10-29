import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { cancelEvent, createEvent, updateEvent } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};

const zoneNames = () => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

// Choices offered for "remind everyone"; the ones outside the server's limits are left out.
const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 360, 720, 1440];
const reminderLabel = (m) =>
  m === 0 ? 'No reminder' : m >= 60 && m % 60 === 0 ? `${m / 60} h before` : `${m} min before`;

function ReminderSelect({ id, value, onChange, limits }) {
  const { min, max } = limitOf(limits, 'reminderMinutes');
  const choices = REMINDER_CHOICES.filter((m) => m === 0 || ((min ?? 0) <= m && m <= (max ?? Infinity)));
  if (!choices.includes(value)) choices.push(value);
  choices.sort((a, b) => a - b);
  return (
    <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {choices.map((m) => (
        <option key={m} value={m}>
          {reminderLabel(m)}
        </option>
      ))}
    </select>
  );
}

function ZoneInput({ id, value, onChange }) {
  return (
    <>
      <input
        id={id}
        type="text"
        list={`${id}-zones`}
        value={value}
        placeholder="Europe/Oslo"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={`${id}-zones`}>
        {zoneNames().map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

const BLANK = (cfg) => ({
  title: '',
  description: '',
  start: '',
  end: '',
  timeZone: browserZone() || cfg.timeZone || 'UTC',
  channelId: cfg.channel || '',
  roleId: '',
  location: '',
  imageUrl: '',
  capacity: '',
  reminderMinutes: cfg.reminderMinutes,
});

function EventForm({ initial, editing, channels, roles, saving, onSave, onCancel }) {
  const limits = useModuleLimits('events');
  const [f, setF] = useState(initial);
  const set = (patch) => setF((cur) => ({ ...cur, ...patch }));

  function submit(e) {
    e.preventDefault();
    onSave({ ...f, capacity: f.capacity === '' ? null : Number(f.capacity) });
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label htmlFor="ev-title">Title</label>
        <input
          id="ev-title"
          type="text"
          required
          maxLength={limitOf(limits, 'title').maxLength}
          value={f.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>

      <div className="v2-field">
        <label htmlFor="ev-description">
          Description <span className="v2-field-hint">— optional</span>
        </label>
        <textarea
          id="ev-description"
          rows={3}
          maxLength={limitOf(limits, 'description').maxLength}
          value={f.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </div>

      <div className="v2-field-row">
        <div className="v2-field">
          <label htmlFor="ev-start">Starts</label>
          <input
            id="ev-start"
            type="datetime-local"
            required
            value={f.start}
            onChange={(e) => set({ start: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="ev-end">
            Ends <span className="v2-field-hint">— optional</span>
          </label>
          <input
            id="ev-end"
            type="datetime-local"
            value={f.end}
            onChange={(e) => set({ end: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="ev-zone">Time zone</label>
          <ZoneInput id="ev-zone" value={f.timeZone} onChange={(timeZone) => set({ timeZone })} />
        </div>
      </div>
      <p className="v2-field-hint">
        The times are read in this time zone. Members see them in their own zone in Discord.
      </p>

      {editing ? null : (
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="ev-channel">Post in</label>
            <select
              id="ev-channel"
              required
              value={f.channelId}
              onChange={(e) => set({ channelId: e.target.value })}
            >
              <option value="">— select a channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="ev-role">
              Participant role <span className="v2-field-hint">— optional</span>
            </label>
            <select id="ev-role" value={f.roleId} onChange={(e) => set({ roleId: e.target.value })}>
              <option value="">— none —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  @{r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="v2-field-row">
        <div className="v2-field">
          <label htmlFor="ev-location">
            Where <span className="v2-field-hint">— optional</span>
          </label>
          <input
            id="ev-location"
            type="text"
            maxLength={limitOf(limits, 'location').maxLength}
            value={f.location}
            onChange={(e) => set({ location: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="ev-capacity">
            Capacity <span className="v2-field-hint">— blank = no limit</span>
          </label>
          <input
            id="ev-capacity"
            type="number"
            min={limitOf(limits, 'capacity').min}
            max={limitOf(limits, 'capacity').max}
            value={f.capacity ?? ''}
            onChange={(e) => set({ capacity: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="ev-reminder">Reminder</label>
          <ReminderSelect
            id="ev-reminder"
            limits={limits}
            value={f.reminderMinutes}
            onChange={(reminderMinutes) => set({ reminderMinutes })}
          />
        </div>
      </div>

      <div className="v2-field">
        <label htmlFor="ev-image">
          Image <span className="v2-field-hint">— optional https link</span>
        </label>
        <input
          id="ev-image"
          type="url"
          maxLength={limitOf(limits, 'imageUrl').maxLength}
          placeholder="https://"
          value={f.imageUrl}
          onChange={(e) => set({ imageUrl: e.target.value })}
        />
      </div>

      <div className="v2-field-row">
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {editing ? 'Save event' : 'Post event'}
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Close
        </button>
      </div>
    </form>
  );
}

const when = (ev) => `${ev.start.replace('T', ' ')} ${ev.timeZone}`;

export default function Events() {
  const cmd = useCmd();
  const limits = useModuleLimits('events');
  const { guildId, data, setData, form, set, status, error, dirty, saving, save, reset } =
    useModuleForm('events');
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === 'error') return <LoadError error={error} what="Events" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const upcoming = data.events.filter((e) => e.state === 'scheduled');
  const past = data.events.filter((e) => e.state !== 'scheduled');

  async function run(action, done) {
    setBusy(true);
    try {
      const { events } = await action();
      setData((d) => ({ ...d, events }));
      done?.();
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onCancelEvent(ev) {
    const ok = await confirmDialog({
      title: `Cancel “${ev.title}”?`,
      body: 'The post is marked as cancelled, the participant role is taken back and sign-ups stop.',
      confirmLabel: 'Cancel event',
    });
    if (ok) await run(() => cancelEvent(guildId, ev.id));
  }

  return (
    <>
      <h1 className="v2-section-title">Events</h1>
      <p className="v2-field-hint">
        Post an event with Join, Maybe and Leave buttons. Staff can also use{' '}
        <code>{cmd('/event create')}</code>, <code>{cmd('/event list')}</code> and{' '}
        <code>{cmd('/event cancel')}</code>.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="channel">Default channel</label>
          <select id="channel" value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="">— the channel the command is used in —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="reminderMinutes">Default reminder</label>
          <ReminderSelect
            id="reminderMinutes"
            limits={limits}
            value={form.reminderMinutes}
            onChange={(reminderMinutes) => set({ reminderMinutes })}
          />
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.dmReminders}
              onChange={(e) => set({ dmReminders: e.target.checked })}
            />
            Also DM the reminder to everyone who pressed Join
          </label>
          <p className="v2-field-hint">Members with DMs closed are skipped quietly.</p>
        </div>

        <div className="v2-field">
          <label htmlFor="timeZone">
            Time zone for commands <span className="v2-field-hint">— blank = UTC</span>
          </label>
          <ZoneInput id="timeZone" value={form.timeZone} onChange={(timeZone) => set({ timeZone })} />
          <p className="v2-field-hint">
            <code>{cmd('/event create')}</code> reads its times in this zone unless the command names another.
          </p>
        </div>

        <div className="v2-field">
          <label>
            Staff roles <span className="v2-field-hint">— may manage events without Manage Events</span>
          </label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.staffRoles}
            onChange={(staffRoles) => set({ staffRoles })}
          />
        </div>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Upcoming events ({upcoming.length})</h2>
        {upcoming.length === 0 ? <p className="v2-note">None scheduled.</p> : null}
        <div className="v2-list">
          {upcoming.map((ev) => (
            <div className="v2-row" key={ev.id}>
              <div className="v2-row-main">
                <h3>
                  #{ev.id} · {ev.title}
                </h3>
                <p>
                  {when(ev)} · #{ev.channel} · ✅ {ev.joined}
                  {ev.capacity ? `/${ev.capacity}` : ''} · ❔ {ev.maybe}
                </p>
                {editingId === ev.id ? (
                  <EventForm
                    editing
                    initial={{ ...ev, capacity: ev.capacity ?? '' }}
                    channels={data.channels}
                    roles={data.roles}
                    saving={busy}
                    onSave={(body) =>
                      run(
                        () => updateEvent(guildId, ev.id, body),
                        () => setEditingId(null)
                      )
                    }
                    onCancel={() => setEditingId(null)}
                  />
                ) : null}
              </div>
              {editingId === ev.id ? null : (
                <div className="v2-field-row">
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busy}
                    onClick={() => setEditingId(ev.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="v2-btn-danger"
                    disabled={busy}
                    onClick={() => onCancelEvent(ev)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {creating ? (
          <EventForm
            initial={BLANK(data.config)}
            channels={data.channels}
            roles={data.roles}
            saving={busy}
            onSave={(body) =>
              run(
                () => createEvent(guildId, body),
                () => setCreating(false)
              )
            }
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
            + New event
          </button>
        )}
      </div>

      {past.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Past events</h2>
          <div className="v2-list">
            {past.map((ev) => (
              <div className="v2-row" key={ev.id}>
                <div className="v2-row-main">
                  <h3>
                    #{ev.id} · {ev.title}
                  </h3>
                  <p>
                    {when(ev)} · {ev.state === 'cancelled' ? 'cancelled' : 'ended'} · ✅ {ev.joined} · ❔{' '}
                    {ev.maybe}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
